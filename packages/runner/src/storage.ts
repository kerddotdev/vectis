import { constants } from "node:fs";
import { lstat, opendir, open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StorageReport, StorageUsage } from "../../protocol/src/storage.js";
import type { Snapshot } from "../../protocol/src/index.js";

async function diskCapacity(path: string): Promise<number | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return undefined;
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, 32, 0);
    if (bytesRead >= 32 && header.readUInt32BE(0) === 0x514649fb) {
      if (![2, 3].includes(header.readUInt32BE(4))) return undefined;
      const capacity = header.readBigUInt64BE(24);
      return capacity <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(capacity) : undefined;
    }
    return stats.size;
  } finally {
    await file.close();
  }
}

export async function measureStorage(
  path: string,
  diskPath = path,
  deadline = Date.now() + 5000,
): Promise<StorageUsage> {
  let count = 0;
  const seen = new Set<string>();
  async function measure(target: string): Promise<{ fileBytes: number; allocatedBytes: number }> {
    if (++count > 10000 || Date.now() > deadline) throw new Error("Measurement limit reached.");
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new Error("Symbolic link inspection is unavailable.");
    if (stats.isFile()) {
      const identity = `${stats.dev}:${stats.ino}`;
      if (seen.has(identity)) return { fileBytes: 0, allocatedBytes: 0 };
      seen.add(identity);
      return { fileBytes: stats.size, allocatedBytes: stats.blocks * 512 };
    }
    if (!stats.isDirectory()) throw new Error("Unsupported storage entry.");
    const total = { fileBytes: 0, allocatedBytes: 0 };
    for await (const entry of await opendir(target)) {
      const usage = await measure(join(target, entry.name));
      total.fileBytes += usage.fileBytes;
      total.allocatedBytes += usage.allocatedBytes;
    }
    return total;
  }
  try {
    const stats = await lstat(path);
    const entries: Array<{ name: string; fileBytes: number; allocatedBytes: number }> = [];
    if (stats.isDirectory()) {
      for await (const entry of await opendir(path)) {
        entries.push({ name: entry.name, ...(await measure(join(path, entry.name))) });
      }
    } else entries.push({ name: basename(path), ...(await measure(path)) });
    const virtualCapacityBytes = await diskCapacity(diskPath).catch(() => undefined);
    return {
      path,
      status: "available",
      fileBytes: entries.reduce((sum, entry) => sum + entry.fileBytes, 0),
      allocatedBytes: entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
      entries,
      ...(virtualCapacityBytes !== undefined ? { virtualCapacityBytes } : {}),
    };
  } catch (error) {
    return {
      path,
      status:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unavailable",
      reason: "Storage is absent, inaccessible, changing, or exceeds the inspection limit.",
    };
  }
}

export async function storageReport(snapshot: Snapshot, home: string): Promise<StorageReport> {
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
      instances.push({ id: instance.id, usage: await measureStorage(directory, disk, deadline) });
    }
    environments.push({
      environmentId: environment.id,
      base: await measureStorage(
        environment.basePath,
        environment.os === "macos" ? join(environment.basePath, "disk.img") : environment.basePath,
        deadline,
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
