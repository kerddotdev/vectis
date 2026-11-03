import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
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
install -d -m 0700 -o vectis -g staff "$home/.ssh"
printf '%s\\n' ${quote(publicKey)} >> "$home/.ssh/authorized_keys"
chown vectis:staff "$home/.ssh/authorized_keys"
chmod 0600 "$home/.ssh/authorized_keys"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\\n' 'vectis ALL=(ALL) NOPASSWD: ALL' > "$work/sudoers"
/usr/sbin/visudo -cf "$work/sudoers"
install -o root -g wheel -m 0440 "$work/sudoers" /etc/sudoers.d/vectis
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
    await writeFile(askpass, '#!/bin/sh\nexec /usr/bin/nc -U "$VECTIS_ASKPASS_SOCKET"\n', {
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
    const command = `sudo -S -p '' /bin/bash -c ${quote(automaticMacEnrollment(key))}`;
    const child = spawn(
      "/usr/bin/ssh",
      [
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
        ...args,
        command,
      ],
      {
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          PATH: "/usr/bin:/bin",
          DISPLAY: "vectis",
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: "force",
          VECTIS_ASKPASS_SOCKET: socketPath,
        },
      },
    );
    let failed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    child.once("error", () => {
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
    signal.throwIfAborted();
    if (failed || child.exitCode !== 0)
      throw new VectisError("macos_enrollment_failed", "Automatic guest SSH enrollment failed.");
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
