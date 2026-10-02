import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Environment } from "../../protocol/src/index.js";
import { executeGuest, GuestUnavailableError, type GuestConnection } from "./guest.js";

const inspect = promisify(execFile);
const probeTimeout = 20000;

const bashProbe = `set +e
echo "== uptime"; uptime
echo "== memory"; free -m 2>/dev/null || vm_stat | head -8
echo "== kernel"; (dmesg 2>/dev/null || sudo -n dmesg 2>/dev/null) | tail -n 40
echo "== runner log"
f=$(ls -t "$HOME"/vectis-actions-runner/_diag/Runner_*.log 2>/dev/null | head -1)
if [ -n "$f" ]; then tail -n 40 "$f"; fi
`;
const powershellProbe = `$ErrorActionPreference = 'Continue'
'== uptime'; (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
'== runner log'
$f = Get-ChildItem (Join-Path $env:USERPROFILE 'vectis-actions-runner\\_diag\\Runner_*.log') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($f) { Get-Content $f -Tail 40 }
`;

function tail(text: string, limit: number) {
  return text.length > limit ? `...${text.slice(-limit)}` : text;
}

async function hostNetwork(host: string) {
  if (host === "127.0.0.1") return "guest is forwarded through a loopback port";
  const [arp, interfaces] = await Promise.all([
    inspect("/usr/sbin/arp", ["-an"], { timeout: 3000, maxBuffer: 1048576 }).catch(() => undefined),
    inspect("/sbin/ifconfig", ["-l"], { timeout: 3000 }).catch(() => undefined),
  ]);
  const entry = arp?.stdout.split("\n").find((line) => line.includes(`(${host})`));
  return [
    `arp: ${entry?.trim() ?? "no entry for the guest address"}`,
    `interfaces: ${interfaces?.stdout.trim() ?? "unreadable"}`,
  ].join("\n");
}

async function guestState(connection: GuestConnection, os: Environment["os"]) {
  try {
    const result = await executeGuest(connection, os === "windows" ? powershellProbe : bashProbe, {
      signal: AbortSignal.timeout(probeTimeout),
      shell: os === "windows" ? "powershell" : "bash",
    });
    return `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  } catch (error) {
    return `unreachable: ${error instanceof GuestUnavailableError ? error.detail : "probe failed"}`;
  }
}

// Called while the VM still runs, because cleanup destroys the evidence. Everything is bounded and
// scrubbed of the given secrets before it is retained.
export async function collectRunnerDiagnostics(input: {
  connection: GuestConnection;
  os: Environment["os"];
  listener: string;
  secrets: readonly string[];
}) {
  const [host, guest] = await Promise.all([
    hostNetwork(input.connection.host),
    guestState(input.connection, input.os),
  ]);
  let text = [
    `collected: ${new Date().toISOString()}`,
    `== listener output\n${tail(input.listener.trim(), 3000)}`,
    `== host network\n${tail(host, 1000)}`,
    `== guest\n${tail(guest.trim(), 11000)}`,
  ].join("\n");
  for (const secret of input.secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return tail(text, 16000);
}
