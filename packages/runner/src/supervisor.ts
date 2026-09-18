import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write("A supervised executable is required.\n");
  process.exit(2);
}
const shutdown = new AbortController();
const children: Array<{ process: ChildProcess; closed: Promise<void> }> = [];
const stop = () => shutdown.abort();
process.stdin.once("end", stop);
process.stdin.once("error", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdin.resume();

function owned(command: string, arguments_: string[], primary: boolean) {
  const child = spawn(command, arguments_, {
    stdio: primary ? ["pipe", "inherit", "inherit"] : ["ignore", "ignore", "inherit"],
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      stop();
      resolve();
    }),
  );
  child.once("error", stop);
  child.stdin?.on("error", stop);
  children.push({ process: child, closed });
  return child;
}

try {
  const tpm = process.env.VECTIS_VM_TPM_EXECUTABLE;
  if (tpm) {
    owned(
      tpm,
      [
        "socket",
        "--tpm2",
        "--tpmstate",
        "dir=tpm,mode=0600,lock",
        "--ctrl",
        "type=unixio,path=tpm.sock,mode=0600",
        "--pid",
        "file=tpm.pid",
      ],
      false,
    );
    const deadline = Date.now() + 5000;
    while (!(await lstat("tpm.sock").catch(() => undefined))?.isSocket()) {
      if (Date.now() > deadline) throw new Error("TPM readiness timed out.");
      await delay(25, undefined, { signal: shutdown.signal });
    }
  }
  shutdown.signal.throwIfAborted();
  const child = owned(executable, args, true);
  if (child.stdin) process.stdin.pipe(child.stdin);
  await new Promise<void>((resolve) => {
    shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
    if (shutdown.signal.aborted) resolve();
  });
} catch {
  process.stderr.write("The supervised VM or TPM could not start.\n");
  process.exitCode = 1;
} finally {
  for (const child of children)
    if (child.process.exitCode === null && child.process.signalCode === null)
      child.process.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children)
      if (child.process.exitCode === null && child.process.signalCode === null)
        child.process.kill("SIGKILL");
  }, 2000);
  await Promise.all(children.map((child) => child.closed));
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
}
