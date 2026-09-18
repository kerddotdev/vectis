import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";

export async function preparationStopped(directory: string, id: string) {
  try {
    const receipt = Schema.decodeUnknownSync(
      Schema.Struct({ instanceId: Schema.String, pid: Schema.Int }),
    )(JSON.parse(await readFile(join(directory, "exit-receipt.json"), "utf8")));
    if (receipt.instanceId !== id || receipt.pid <= 0) return false;
    try {
      process.kill(receipt.pid, 0);
      return false;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  } catch {
    return false;
  }
}
export async function runPreparationGuest(
  input: {
    helper: string;
    directory: string;
    id: string;
    cpu: number;
    memoryMiB: number;
    marker: string;
  },
  signal: AbortSignal,
) {
  return runPreparationProcess(
    {
      ...input,
      args: [
        "run",
        "linux",
        join(input.directory, "disk.img"),
        String(input.cpu),
        String(input.memoryMiB),
        join(input.directory, "efi.bin"),
        join(input.directory, "seed.iso"),
      ],
      markerStream: "stderr",
    },
    signal,
  );
}
export async function runPreparationProcess(
  input: {
    helper: string;
    directory: string;
    id: string;
    args: readonly string[];
    marker: string;
    markerStream: "stdout" | "stderr";
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { directory, id } = input;
  const receipt = join(directory, "exit-receipt.json");
  const child = spawn(input.helper, [...input.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VECTIS_EXIT_RECEIPT: receipt, VECTIS_INSTANCE_ID: id },
  });
  child.stdin.on("error", () => {});
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  let serial = "";
  let prepared = false;
  let events = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    events = (events + chunk).slice(-16384);
    if (input.markerStream === "stdout" && events.includes(input.marker)) prepared = true;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    serial = (serial + chunk).slice(-65536);
    if (input.markerStream === "stderr" && serial.includes(input.marker)) prepared = true;
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (force) return;
    child.stdin.end();
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    await closed;
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(force);
    child.stdin.destroy();
    await writeFile(join(directory, "preparation.log"), events + "\n" + serial, { mode: 0o600 });
    if (child.pid)
      await writeFile(receipt, JSON.stringify({ instanceId: id, pid: child.pid }), { mode: 0o600 });
  }
  signal.throwIfAborted();
  if (failed || child.exitCode !== 0 || !prepared)
    throw new VectisError(
      "guest_preparation_failed",
      "The guest did not confirm successful preparation.",
      "Inspect the private preparation log and resume setup after fixing network or runtime prerequisites.",
    );
}
