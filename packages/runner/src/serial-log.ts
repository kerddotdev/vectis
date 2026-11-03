import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

export const serialLogLimit = 1024 * 1024;
const segmentLimit = serialLogLimit / 2;
const retainedLogs = 50;
const ownedName = /^([A-Za-z0-9_-]+)\.log(?:\.1)?$/;

export function serialLogPath(home: string, id: string) {
  if (!id || /[^A-Za-z0-9_-]/.test(id)) throw new Error("Invalid serial log instance id.");
  return join(home, "diagnostics", "serial", `${id}.log`);
}

export async function pruneSerialLogs(home: string) {
  const directory = join(home, "diagnostics", "serial");
  const entries = await readdir(directory, { withFileTypes: true });
  const logs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && ownedName.exec(entry.name)?.[0] === entry.name)
      .map(async (entry) => {
        const path = join(directory, entry.name);
        const info = await lstat(path).catch(() => undefined);
        const id = ownedName.exec(entry.name)?.[1];
        return info?.isFile() && id ? { id, path, modified: info.mtimeMs } : undefined;
      }),
  );
  const instances = new Map<string, { paths: string[]; modified: number }>();
  for (const log of logs) {
    if (!log) continue;
    const instance = instances.get(log.id) ?? { paths: [], modified: 0 };
    instance.paths.push(log.path);
    instance.modified = Math.max(instance.modified, log.modified);
    instances.set(log.id, instance);
  }
  const existing = [...instances.entries()];
  existing.sort((a, b) => b[1].modified - a[1].modified || a[0].localeCompare(b[0]));
  await Promise.all(
    existing.slice(retainedLogs).flatMap(([, log]) =>
      log.paths.map((path) =>
        unlink(path).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }),
      ),
    ),
  );
}

export async function createSerialLog(home: string, id: string) {
  const path = serialLogPath(home, id);
  await mkdir(join(home, "diagnostics", "serial"), { recursive: true, mode: 0o700 });
  let file = await open(path, "ax", 0o600);
  await pruneSerialLogs(home).catch(() => {});
  let size = 0;
  let pending = Buffer.alloc(0);
  let droppedBytes = 0;
  let inFlightBytes = 0;
  let writing: Promise<void> | undefined;
  let failed = false;
  let closed = false;
  const flush = () => {
    writing ??= (async () => {
      while (pending.length && !failed) {
        const snapshot = pending;
        inFlightBytes = snapshot.length;
        pending = Buffer.alloc(0);
        let offset = 0;
        while (offset < snapshot.length) {
          if (size === segmentLimit) {
            await file.close();
            await rename(path, `${path}.1`);
            file = await open(path, "ax", 0o600);
            size = 0;
          }
          const length = Math.min(snapshot.length - offset, segmentLimit - size);
          const { bytesWritten } = await file.write(snapshot, offset, length, null);
          if (!bytesWritten) throw new Error("Serial log write made no progress.");
          offset += bytesWritten;
          inFlightBytes -= bytesWritten;
          size += bytesWritten;
        }
      }
    })()
      .catch(() => {
        failed = true;
        droppedBytes += pending.length + inFlightBytes;
        inFlightBytes = 0;
        pending = Buffer.alloc(0);
      })
      .finally(() => {
        writing = undefined;
      });
    return writing;
  };
  return {
    get pendingBytes() {
      return pending.length;
    },
    get droppedBytes() {
      return droppedBytes;
    },
    attach(stream: Readable) {
      // Never backpressure the VM, even if host storage fails or cannot keep up.
      stream.on("data", (chunk: Buffer) => {
        if (failed || closed) {
          droppedBytes += chunk.length;
          return;
        }
        const dropped = Math.max(0, pending.length + chunk.length - serialLogLimit);
        droppedBytes += dropped;
        pending =
          chunk.length >= serialLogLimit
            ? Buffer.from(chunk.subarray(-serialLogLimit))
            : Buffer.concat([pending.subarray(dropped), chunk]);
        void flush();
      });
      stream.resume();
    },
    async close() {
      closed = true;
      await flush();
      await file.close();
    },
  };
}

export async function readSerialTail(home: string, id: string) {
  const path = serialLogPath(home, id);
  const buffers: Buffer[] = [];
  let remaining = 8192;
  for (const segment of [path, `${path}.1`]) {
    if (!remaining) break;
    const file = await open(segment, "r").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) continue;
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, remaining));
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      buffers.unshift(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    } finally {
      await file.close();
    }
  }
  return Buffer.concat(buffers).toString("utf8");
}
