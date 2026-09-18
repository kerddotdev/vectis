import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { StorageUsage, type StorageReport } from "../../protocol/src/storage.js";
import type { Snapshot } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";
export { measureStorage } from "./storage-measure.js";

export async function inspectStorage(
  path: string,
  diskPath: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<StorageUsage> {
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Inspection deadline reached.");
    const timeout = AbortSignal.timeout(Math.min(remaining, 5000));
    const worker = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./storage-measure.ts" : "./storage-measure.js",
        import.meta.url,
      ),
    );
    const output = await runProcess(
      process.execPath,
      [worker, "--vectis-measure-storage", path, diskPath, String(deadline)],
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    return Schema.decodeUnknownSync(StorageUsage)(JSON.parse(output));
  } catch {
    return {
      path,
      status: "unavailable",
      reason:
        "Storage inspection did not complete. Check that the volume is connected and that the background runtime has access in macOS System Settings > Privacy & Security > Files and Folders, then retry.",
    };
  }
}

export async function storageReport(
  snapshot: Snapshot,
  home: string,
  signal?: AbortSignal,
): Promise<StorageReport> {
  const deadline = Date.now() + 10000;
  const environments: Array<StorageReport["environments"][number]> = [];
  for (const environment of snapshot.environments) {
    const instances: Array<StorageReport["environments"][number]["instances"][number]> = [];
    for (const instance of snapshot.instances.filter(
      (item) => item.environmentId === environment.id && item.status !== "stopped",
    )) {
      const directory = instance.directory ?? join(home, "instances", instance.id);
      const disk =
        environment.os === "macos"
          ? join(directory, "bundle", "disk.img")
          : join(directory, environment.os === "windows" ? "disk.qcow2" : "disk.img");
      instances.push({
        id: instance.id,
        usage: await inspectStorage(directory, disk, deadline, signal),
      });
    }
    environments.push({
      environmentId: environment.id,
      base: await inspectStorage(
        environment.basePath,
        environment.os === "macos" ? join(environment.basePath, "disk.img") : environment.basePath,
        deadline,
        signal,
      ),
      instances,
      guestBreakdown: "unavailable",
    });
  }
  return {
    measuredAt: new Date().toISOString(),
    allocationNote:
      "Allocated bytes are filesystem-reported blocks. Shared copy-on-write blocks may be counted in more than one image. Host file breakdown does not describe files inside the guest.",
    environments,
  };
}
