import { fileURLToPath } from "node:url";
import { VectisError } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";

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
  try {
    const output = await runProcess(
      process.execPath,
      [worker, source, directory, options.createDirectory ? "create" : "existing"],
      signal ? AbortSignal.any([signal, deadline]) : deadline,
    );
    if (output !== "accessible") throw new Error("Storage probe did not confirm access.");
  } catch {
    signal?.throwIfAborted();
    throw new VectisError(
      "storage_access_required",
      "The background runtime could not verify image and storage access. No VM was started.",
      "Connect the volume and allow Vectis Runtime access in macOS System Settings > Privacy & Security > Files and Folders, or select accessible storage. Then retry the operation.",
    );
  }
}
