import { fileURLToPath } from "node:url";
import { VectisError } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";

const WORKING_RESERVE_BYTES = 20 * 1024 ** 3;
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

export async function probeStorage(
  source: string,
  directory: string,
  signal?: AbortSignal,
  options: { createDirectory?: boolean } = {},
) {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./storage-probe-worker.ts" : "./storage-probe-worker.js",
      import.meta.url,
    ),
  );
  const deadline = AbortSignal.timeout(5000);
  let freeBytes: number;
  try {
    const output = await runProcess(
      process.execPath,
      [worker, source, directory, options.createDirectory ? "create" : "existing"],
      signal ? AbortSignal.any([signal, deadline]) : deadline,
    );
    freeBytes = Number(output);
    if (!output.trim() || !Number.isFinite(freeBytes) || freeBytes < 0)
      throw new Error("Storage probe did not confirm free space.");
  } catch {
    signal?.throwIfAborted();
    throw new VectisError(
      "storage_access_required",
      "The background runtime could not verify image and storage access. No VM was started.",
      "Connect the volume and allow Vectis Runtime access in macOS System Settings > Privacy & Security > Files and Folders, or select accessible storage. Then retry the operation.",
    );
  }
  if (freeBytes < WORKING_RESERVE_BYTES)
    throw new VectisError(
      "storage_headroom",
      `Only ${gib(freeBytes)} GiB is free at ${directory}; starting a VM needs at least ${gib(WORKING_RESERVE_BYTES)} GiB. No VM was started.`,
      "Free space or use environment configure --storage-path to select another volume, then retry.",
    );
}
