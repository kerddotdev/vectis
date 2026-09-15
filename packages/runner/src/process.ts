import { spawn } from "node:child_process";
import { VectisError } from "../../protocol/src/index.js";

export async function runProcess(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
    : AbortSignal.timeout(120000);
  if (deadline.aborted)
    throw new VectisError("process_cancelled", "The external command was cancelled.");
  const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let failed = false;
  let output = "";
  let force: ReturnType<typeof setTimeout> | undefined;
  child.once("error", () => {
    failed = true;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output = (output + chunk).slice(-65536);
  });
  child.stderr.resume();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const cancel = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1000);
  };
  deadline.addEventListener("abort", cancel, { once: true });
  if (deadline.aborted) cancel();
  try {
    await closed;
  } finally {
    deadline.removeEventListener("abort", cancel);
    clearTimeout(force);
  }
  if (deadline.aborted)
    throw new VectisError("process_cancelled", "The external command was cancelled or timed out.");
  if (failed || child.exitCode !== 0)
    throw new VectisError(
      "process_failed",
      "An external command failed.",
      "Inspect the environment and runtime configuration.",
    );
  return output;
}
