import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
import { guestCommandDiagnostics } from "./guest-diagnostics.js";
import { guestArguments, type GuestConnection } from "./guest.js";

export function automaticMacSetup(hostSupported: boolean, guestMajor: number, manual?: true) {
  return hostSupported && guestMajor >= 27 && !manual;
}
export function macSetupPassword() {
  return `Vx9!${randomBytes(32).toString("hex")}`;
}
export async function installedMacMajor(bundle: string) {
  const metadata = Schema.decodeUnknownSync(Schema.Struct({ majorVersion: Schema.Int }))(
    JSON.parse(await readFile(join(bundle, "installation.json"), "utf8")),
  );
  return metadata.majorVersion;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function automaticMacEnrollment(publicKey: string) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey))
    throw new Error("Invalid guest public key.");
  return `set -eu
home=/Users/vectis
printf 'enroll.ssh_dir\\n'
install -d -m 0700 -o vectis -g staff "$home/.ssh"
printf '%s\\n' ${quote(publicKey)} >> "$home/.ssh/authorized_keys"
chown vectis:staff "$home/.ssh/authorized_keys"
chmod 0600 "$home/.ssh/authorized_keys"
printf 'enroll.sudoers\\n'
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\\n' 'vectis ALL=(ALL) NOPASSWD: ALL' > "$work/sudoers"
/usr/sbin/visudo -cf "$work/sudoers"
install -o root -g wheel -m 0440 "$work/sudoers" /etc/sudoers.d/vectis
printf 'enroll.sshd\\n'
mkdir -p /etc/ssh/sshd_config.d
printf '%s\\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > "$work/sshd"
install -o root -g wheel -m 0644 "$work/sshd" /etc/ssh/sshd_config.d/000-vectis.conf
/usr/sbin/sshd -t
`;
}
export const macCommandLineTools = `set -eu
marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
sudo -n touch "$marker"
trap 'sudo -n rm -f "$marker"' EXIT
printf 'toolchain.searching\\n'
label=$(/usr/sbin/softwareupdate -l | sed -n 's/^[[:space:]]*\\* Label: \\(Command Line Tools.*\\)$/\\1/p' | tail -1)
[ -n "$label" ]
printf 'toolchain.installing\\n'
sudo -n /usr/sbin/softwareupdate -i "$label" --verbose
/usr/bin/git --version
`;

export async function waitForMacSsh(host: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port: 22 });
      const finish = (ok: boolean) => {
        socket.destroy();
        signal.removeEventListener("abort", cancel);
        resolve(ok);
      };
      const cancel = () => finish(false);
      socket.setTimeout(2000, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    if (ready) return;
    await delay(1000, undefined, { signal });
  }
}

export class MacEnrollmentError extends VectisError {
  constructor(readonly diagnostics: string) {
    super("macos_enrollment_failed", "Automatic guest SSH enrollment failed.");
  }
}

function enrollmentOutput(password: string) {
  let pending = "";
  let output = "";
  let step = "";
  let line = "";
  const retain = (text: string) => {
    output = (output + text).slice(-4096);
    const lines = (line + text).split("\n");
    line = (lines.pop() ?? "").slice(-80);
    for (const value of lines)
      if (/^enroll\.(ssh_dir|sudo_check|sudoers|sshd)$/.test(value)) step = value;
  };
  return {
    write(chunk: string) {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf(password)) !== -1) {
        retain(pending.slice(0, index) + "[REDACTED]");
        pending = pending.slice(index + password.length);
      }
      let suffix = Math.min(pending.length, password.length - 1);
      while (suffix > 0 && !password.startsWith(pending.slice(-suffix))) suffix--;
      const safe = pending.slice(0, pending.length - suffix);
      retain(safe);
      pending = pending.slice(pending.length - suffix);
    },
    finish() {
      retain(pending);
      pending = "";
      if (/^enroll\.(ssh_dir|sudo_check|sudoers|sshd)$/.test(line)) step = line;
      return { text: output, step };
    },
  };
}

export async function enrollAutomaticMac(
  connection: GuestConnection,
  password: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "vectis-askpass-"));
  const socketPath = join(directory, "socket");
  const askpass = join(directory, "askpass");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end(password + "\n");
  });
  server.maxConnections = 1;
  try {
    // -d: askpass inherits ssh's stdin, which carries the sudo password for the remote command.
    await writeFile(askpass, '#!/bin/sh\nexec /usr/bin/nc -d -U "$VECTIS_ASKPASS_SOCKET"\n', {
      mode: 0o700,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const args = guestArguments(connection).map((arg) =>
      arg === "BatchMode=yes"
        ? "BatchMode=no"
        : arg === "StrictHostKeyChecking=yes"
          ? "StrictHostKeyChecking=accept-new"
          : arg,
    );
    const key = (await readFile(connection.identityFile + ".pub", "utf8")).trim();
    const command = `set -eu
printf 'enroll.sudo_check\\n'
id -Gn
if ! id -Gn | /usr/bin/grep -qw admin; then
  printf '%s\\n' 'provisioned user lacks administrator rights' >&2
  exit 1
fi
sudo -S -p '' /bin/bash -c ${quote(automaticMacEnrollment(key))}`;
    const deadline = Date.now() + 300000;
    signal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
    let diagnostics = "";
    while (true) {
      if (signal.aborted) throw new MacEnrollmentError(diagnostics);
      const stdout = enrollmentOutput(password);
      const stderr = enrollmentOutput(password);
      const child = spawn(
        "/usr/bin/ssh",
        [
          "-o",
          "PreferredAuthentications=keyboard-interactive,password",
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "NumberOfPasswordPrompts=1",
          ...args,
          command,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            DISPLAY: "vectis",
            SSH_ASKPASS: askpass,
            SSH_ASKPASS_REQUIRE: "force",
            VECTIS_ASKPASS_SOCKET: socketPath,
          },
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdout.write(chunk));
      child.stderr.on("data", (chunk: string) => stderr.write(chunk));
      let failed = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      child.once("error", (error) => {
        stderr.write(error.message);
        failed = true;
      });
      child.stdin.on("error", () => {});
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const cancel = () => {
        child.kill("SIGTERM");
        force ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1000);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdin.end(password + "\n");
      try {
        await closed;
      } finally {
        signal.removeEventListener("abort", cancel);
        clearTimeout(force);
        child.stdin.destroy();
      }
      const out = stdout.finish();
      const err = stderr.finish();
      diagnostics = `exitCode: ${child.exitCode ?? "unknown"}\nstep: ${out.step || err.step || "ssh.authentication"}\n${guestCommandDiagnostics({ stdout: out.text, stderr: err.text })}`;
      if (signal.aborted) throw new MacEnrollmentError(diagnostics);
      if (!failed && child.exitCode === 0) return;
      const retryable =
        !failed && child.exitCode === 255 && /Permission denied|Connection reset/i.test(err.text);
      if (!retryable || Date.now() + 10000 >= deadline) throw new MacEnrollmentError(diagnostics);
      try {
        await delay(10000, undefined, { signal });
      } catch {
        throw new MacEnrollmentError(diagnostics);
      }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
