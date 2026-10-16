import { mkdtemp, writeFile, stat, rm, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CacheVolumes } from "./cache-volume.js";
import { runProcess } from "./process.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-cache-"));
  homes.push(home);
  const environment = {
    id: "linux",
    name: "Linux",
    os: "linux",
    state: "ready",
    basePath: join(home, "base"),
    cpu: 1,
    memoryMiB: 512,
  } as const;
  const binding = { installationId: 1, repositoryId: 2 };
  const volumes = new CacheVolumes(home);
  const first = await volumes.acquire(environment, binding, 1);
  return { home, environment, binding, volumes, first };
}
async function bytes(path: string) {
  const file = await open(path, "r");
  try {
    const data = Buffer.alloc(8);
    await file.read(data, 0, 8, 0);
    return data.toString();
  } finally {
    await file.close();
  }
}
async function fork(path: string, destination: string, content: string) {
  await runProcess("/bin/cp", ["-c", path, destination]);
  const file = await open(destination, "r+");
  try {
    await file.write(content, 0, "utf8");
  } finally {
    await file.close();
  }
}
const hostTest = test.skipIf(process.platform !== "darwin");
hostTest(
  "parallel forks isolate writes, discard untrusted jobs and serialize atomic last-writer-wins promotion",
  async () => {
    const { home, first, volumes, environment, binding } = await fixture();
    expect((await stat(first.disk.sourcePath)).size).toBe(1024 ** 3);
    expect((await stat(first.disk.sourcePath)).blocks).toBeLessThan(2048);
    const second = await volumes.acquire(environment, binding, 1);
    const untrusted = await volumes.acquire(environment, binding, 1);
    const a = join(home, "a.img"),
      b = join(home, "b.img"),
      c = join(home, "c.img");
    await Promise.all([
      fork(first.disk.sourcePath, a, "firstjob"),
      fork(first.disk.sourcePath, b, "last-job"),
      fork(first.disk.sourcePath, c, "PR-cache"),
    ]);
    expect(await bytes(first.disk.sourcePath)).toBe("\0".repeat(8));
    await untrusted.disk.stopped(c);
    expect(await bytes(first.disk.sourcePath)).toBe("\0".repeat(8));
    first.authorizeWrite();
    second.authorizeWrite();
    await Promise.all([first.disk.stopped(a), second.disk.stopped(b)]);
    expect(await bytes(first.disk.sourcePath)).toBe("last-job");
    expect(await bytes(join(first.directory, "cache.previous.img"))).toBe("firstjob");
    expect((await readdir(first.directory)).sort()).toEqual(["cache.img", "cache.previous.img"]);
    first.release();
    second.release();
    untrusted.release();
  },
);
test("clear refuses active users, then removes the volume and previous generation", async () => {
  const { first, volumes } = await fixture();
  await writeFile(join(first.directory, "cache.previous.img"), "previous");
  await expect(volumes.clear(first.directory)).rejects.toMatchObject({ code: "cache_in_use" });
  first.release();
  await volumes.clear(first.directory);
  await expect(stat(first.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
hostTest(
  "disconnect deletes generations and fences an already-authorized late writer",
  async () => {
    const { home, first, volumes } = await fixture();
    const path = join(home, "cache-fork.img");
    await fork(first.disk.sourcePath, path, "trusted!");
    first.authorizeWrite();
    await volumes.disconnect(first.directory);
    await first.disk.stopped(path);
    await expect(stat(first.disk.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    first.release();
  },
);
test("cache identity uses numeric authority and isolates environments and installations", async () => {
  const { home, first, volumes, environment, binding } = await fixture();
  expect(first.directory).toBe(join(home, "instances/cache/linux/1-2"));
  expect(volumes.directory(environment, { ...binding, installationId: 3 })).not.toBe(
    first.directory,
  );
  expect(volumes.directory({ ...environment, id: "macos" }, binding)).not.toBe(first.directory);
  expect(volumes.directory(environment, { ...binding, repositoryId: 3 })).not.toBe(first.directory);
  expect(() => volumes.directory(environment, { repositoryId: 2 })).toThrow("numeric");
  await expect(volumes.acquire(environment, binding, 2)).rejects.toMatchObject({
    code: "cache_size_changed",
  });
  first.release();
  await volumes.clear(first.directory);
  const next = await volumes.acquire(environment, binding, 2);
  expect((await stat(next.disk.sourcePath)).size).toBe(2 * 1024 ** 3);
  next.release();
});
test("missing external storage is never recreated on the host", async () => {
  const { home, first, volumes, environment, binding } = await fixture();
  first.release();
  const storagePath = join(home, "unmounted", "instances");
  await expect(volumes.acquire({ ...environment, storagePath }, binding, 1)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(home, "unmounted"))).rejects.toMatchObject({ code: "ENOENT" });
});

hostTest(
  "a missing current generation recovers the previous one without modifying it",
  async () => {
    const { first, environment, binding, volumes } = await fixture();
    const previous = join(first.directory, "cache.previous.img");
    await fork(first.disk.sourcePath, previous, "previous");
    first.release();
    await rm(first.disk.sourcePath);
    const recovered = await volumes.acquire(environment, binding, 1);
    expect(await bytes(recovered.disk.sourcePath)).toBe("previous");
    expect(await bytes(previous)).toBe("previous");
    recovered.release();
  },
);
