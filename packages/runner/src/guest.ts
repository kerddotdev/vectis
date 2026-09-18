import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { VectisError } from "../../protocol/src/index.js";

export interface GuestConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly hostKeyAlias: string;
}

export function sshPathOption(name: "IdentityFile" | "UserKnownHostsFile", path: string) {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path) || path.includes("${"))
    throw new VectisError(
      "invalid_guest_connection",
      "SSH identity paths must be absolute and cannot contain control characters or environment substitutions.",
    );
  const escaped = path.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `${name}="${escaped}"`;
}

export function guestArguments(connection: GuestConnection) {
  if (
    !isIP(connection.host) ||
    !Number.isInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535 ||
    !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(connection.user) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(connection.hostKeyAlias) ||
    !isAbsolute(connection.identityFile) ||
    !isAbsolute(connection.knownHostsFile)
  )
    throw new VectisError("invalid_guest_connection", "The guest connection is invalid.");
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    sshPathOption("UserKnownHostsFile", connection.knownHostsFile),
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${connection.hostKeyAlias}`,
    "-o",
    sshPathOption("IdentityFile", connection.identityFile),
    "-p",
    String(connection.port),
    "-l",
    connection.user,
    "--",
    connection.host,
  ];
}

export async function executeGuest(
  connection: GuestConnection,
  script: string,
  options: { signal: AbortSignal; shell?: "bash" | "powershell" },
) {
  if (Buffer.byteLength(script) > 65536)
    throw new VectisError("guest_script_too_large", "Guest scripts cannot exceed 64 KiB.");
  options.signal.throwIfAborted();
  const args = guestArguments(connection);
  const command =
    options.shell === "powershell"
      ? `powershell.exe -NoLogo -NonInteractive -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { & ([scriptblock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine('Guest script failed.'); exit 1 }"`
      : "bash -s";
  const child = spawn("/usr/bin/ssh", [...args, command], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let failed = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const retain = (current: string, chunk: string) => {
    const joined = current + chunk;
    if (joined.length > 32768) truncated = true;
    return joined.slice(-32768);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = retain(stdout, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = retain(stderr, chunk);
  });
  child.once("error", () => {
    failed = true;
  });
  child.stdin.on("error", () => {
    failed = true;
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const cancel = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1000);
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  child.stdin.end(script + "\n");
  try {
    await closed;
  } finally {
    options.signal.removeEventListener("abort", cancel);
    clearTimeout(force);
  }
  if (options.signal.aborted)
    throw new VectisError(
      "guest_cancelled",
      "Guest control was cancelled. Stop the owned VM to terminate remaining guest work.",
    );
  if (failed || child.exitCode === null || child.exitCode === 255)
    throw new VectisError(
      "guest_unavailable",
      "The verified guest connection failed.",
      "Check guest readiness, SSH authorization and its pinned host key.",
    );
  return { exitCode: child.exitCode, stdout, stderr, truncated };
}
