import { spawn } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";

const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write("A supervised executable is required.\n");
  process.exit(2);
}
const child = spawn(executable, args, { stdio: ["pipe", "inherit", "inherit"] });
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000);
}
child.once("error", () => {
  process.stderr.write("The supervised executable could not start.\n");
});
child.once("close", (code) => {
  clearTimeout(timer);
  const receipt = process.env.VECTIS_EXIT_RECEIPT;
  const instanceId = process.env.VECTIS_INSTANCE_ID;
  if (receipt && instanceId) {
    try {
      writeFileSync(receipt + ".tmp", JSON.stringify({ instanceId, pid: process.pid }), {
        mode: 0o600,
      });
      renameSync(receipt + ".tmp", receipt);
    } catch {
      process.stderr.write("Unable to persist VM exit receipt.\n");
    }
  }
  process.stdin.destroy();
  process.exit(code ?? 1);
});
child.stdin.on("error", stop);
process.stdin.pipe(child.stdin);
process.stdin.once("end", stop);
process.stdin.once("error", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
