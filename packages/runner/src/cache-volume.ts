import { mkdir, open, rename, rm, stat, access, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { CacheSizeGiB } from "../../protocol/src/cache-volume.js";
import { VectisError, type Environment } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";

export interface CacheDisk {
  sourcePath: string;
  stopped(path: string): Promise<void>;
}

export class CacheVolumes {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly users = new Map<string, number>();
  constructor(private readonly home: string) {}

  directory(
    environment: Environment,
    binding: { installationId?: number | undefined; repositoryId: number },
  ) {
    if (
      !Number.isSafeInteger(binding.installationId) ||
      (binding.installationId ?? 0) <= 0 ||
      !Number.isSafeInteger(binding.repositoryId) ||
      binding.repositoryId <= 0
    )
      throw new VectisError(
        "cache_identity_missing",
        "Cache volumes require numeric installation and repository IDs.",
      );
    const root = environment.storagePath ?? join(this.home, "instances");
    if (!isAbsolute(root) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(environment.id))
      throw new VectisError("invalid_path", "The cache storage path or environment ID is invalid.");
    return join(root, "cache", environment.id, `${binding.installationId}-${binding.repositoryId}`);
  }

  private async serial<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(directory) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(directory, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(directory) === next) this.queues.delete(directory);
    }
  }

  async acquire(
    environment: Environment,
    binding: { installationId?: number | undefined; repositoryId: number },
    sizeGiB: number,
  ) {
    if (!Schema.is(CacheSizeGiB)(sizeGiB))
      throw new VectisError("invalid_cache_size", "Cache size must be 1 to 1024 GiB.");
    const directory = this.directory(environment, binding);
    const sourcePath = join(directory, "cache.img");
    const sizeBytes = sizeGiB * 1024 ** 3;
    const previousUsers = this.users.get(directory) ?? 0;
    this.users.set(directory, previousUsers + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.users.get(directory) ?? 1) - 1;
      if (count) this.users.set(directory, count);
      else this.users.delete(directory);
    };
    try {
      await this.serial(directory, async () => {
        // A selected external volume must exist; never recreate its mount point on the host.
        if (environment.storagePath) await access(environment.storagePath);
        if (await stat(join(directory, "disconnected")).catch(() => undefined)) {
          if (previousUsers)
            throw new VectisError("cache_in_use", "The disconnected cache still has active jobs.");
          await rm(directory, { recursive: true, force: true });
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await rm(join(directory, "cache.previous.tmp"), { force: true });
        const current = await stat(sourcePath).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (current) {
          if (!current.isFile() || current.size !== sizeBytes)
            throw new VectisError(
              "cache_size_changed",
              "Clear the cache before changing its size cap.",
            );
          return;
        }
        const temporary = join(directory, "cache.creating");
        await rm(temporary, { force: true });
        const previous = join(directory, "cache.previous.img");
        const backup = await stat(previous).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (backup) {
          if (!backup.isFile() || backup.size !== sizeBytes)
            throw new VectisError(
              "cache_size_changed",
              "Clear the cache before changing its size cap.",
            );
          await runProcess("/bin/cp", ["-c", previous, temporary]);
        } else {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.truncate(sizeBytes);
            await file.sync();
          } finally {
            await file.close();
          }
        }
        await rename(temporary, sourcePath);
        const folder = await open(directory, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
    let write = false;
    return {
      directory,
      authorizeWrite: (allowed = true) => {
        write = allowed;
      },
      release,
      disk: {
        sourcePath,
        stopped: (path: string) =>
          this.serial(directory, async () => {
            if (!write || (await stat(join(directory, "disconnected")).catch(() => undefined)))
              return;
            const fork = await stat(path);
            if (!fork.isFile() || fork.size !== sizeBytes)
              throw new VectisError(
                "cache_size_changed",
                "The cache fork no longer matches its size cap.",
              );
            const file = await open(path, "r+");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
            const backup = join(directory, "cache.previous.tmp");
            await rm(backup, { force: true });
            try {
              await runProcess("/bin/cp", ["-c", sourcePath, backup]);
              await rename(backup, join(directory, "cache.previous.img"));
              await rename(path, sourcePath);
              const folder = await open(directory, "r");
              try {
                await folder.sync();
              } finally {
                await folder.close();
              }
            } finally {
              await rm(backup, { force: true });
            }
          }),
      } satisfies CacheDisk,
    };
  }

  async clear(directory: string) {
    await this.serial(directory, async () => {
      if (this.users.get(directory))
        throw new VectisError(
          "cache_in_use",
          "Wait for cache jobs to stop before clearing the volume.",
        );
      await rm(directory, { recursive: true, force: true });
    });
  }

  async disconnect(directory: string) {
    await this.serial(directory, async () => {
      if (!(await stat(directory).catch(() => undefined))) return;
      await writeFile(join(directory, "disconnected"), "", { mode: 0o600 });
      await rm(join(directory, "cache.img"), { force: true });
      await rm(join(directory, "cache.previous.img"), { force: true });
      if (!this.users.get(directory)) await rm(directory, { recursive: true, force: true });
    });
  }
}
