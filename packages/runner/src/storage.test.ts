import { mkdtemp, rm, open, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { measureStorage } from "./storage.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-storage-"));
  homes.push(home);
  return home;
}

test("distinguishes sparse disk capacity from physically allocated blocks", async () => {
  const home = await fixture();
  const path = join(home, "disk.img");
  const file = await open(path, "w");
  try {
    await file.truncate(64 * 1024 ** 2);
    await file.write(Buffer.alloc(4096, 1), 0, 4096, 0);
  } finally {
    await file.close();
  }
  const result = await measureStorage(path);
  expect(result.status).toBe("available");
  expect(result.fileBytes).toBe(64 * 1024 ** 2);
  expect(result.virtualCapacityBytes).toBe(result.fileBytes);
  expect(result.allocatedBytes).toBeLessThan(result.fileBytes ?? 0);
});
test("reads QCOW2 virtual capacity independently of container file size", async () => {
  const home = await fixture();
  const path = join(home, "disk.qcow2");
  const header = Buffer.alloc(104);
  header.writeUInt32BE(0x514649fb, 0);
  header.writeUInt32BE(3, 4);
  header.writeBigUInt64BE(128n * 1024n ** 3n, 24);
  await writeFile(path, header);
  const result = await measureStorage(path);
  expect(result.fileBytes).toBe(104);
  expect(result.virtualCapacityBytes).toBe(128 * 1024 ** 3);
});
test("reports file breakdown and never follows a symlink into another directory", async () => {
  const home = await fixture();
  await writeFile(join(home, "disk.img"), "disk");
  await writeFile(join(home, "efi.bin"), "firmware");
  expect((await measureStorage(home)).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "disk.img", fileBytes: 4 }),
      expect.objectContaining({ name: "efi.bin", fileBytes: 8 }),
    ]),
  );
  await symlink(tmpdir(), join(home, "outside"));
  expect((await measureStorage(home)).status).toBe("unavailable");
});

test("isolated inspection reports the same sparse capacity", async () => {
  const { inspectStorage } = await import("./storage.js");
  const home = await fixture();
  const path = join(home, "disk.img");
  await writeFile(path, "isolated");
  expect(await inspectStorage(path, path, Date.now() + 5000)).toMatchObject({
    status: "available",
    fileBytes: 8,
    virtualCapacityBytes: 8,
  });
});

test.skipIf(process.platform === "win32")(
  "blocked filesystem inspection is terminated within its deadline",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { inspectStorage } = await import("./storage.js");
    const home = await fixture();
    const disk = join(home, "pipe");
    execFileSync("mkfifo", [disk]);
    const file = join(home, "regular");
    await writeFile(file, "data");
    const started = Date.now();
    const result = await inspectStorage(file, disk, Date.now() + 200);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("background runtime");
    expect(Date.now() - started).toBeLessThan(2500);
  },
);
