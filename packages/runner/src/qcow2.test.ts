import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { convertQcow2ToRaw } from "./qcow2.js";

const cluster = 4096;
const size = 4 * cluster + 200;
const plain = Buffer.alloc(cluster, 0x61);
const compressible = Buffer.from("vectis ".repeat(cluster / 7 + 1)).subarray(0, cluster);
const tail = Buffer.alloc(cluster, 0x7a);

function image(version: 2 | 3, edit: (file: Buffer) => void = () => {}) {
  const file = Buffer.alloc(8 * cluster);
  const header = file.subarray(0, 104);
  header.writeUInt32BE(0x514649fb, 0);
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(12, 20);
  header.writeBigUInt64BE(BigInt(size), 24);
  header.writeUInt32BE(1, 36);
  header.writeBigUInt64BE(BigInt(cluster), 40);
  if (version === 3) header.writeUInt32BE(104, 100);
  file.writeBigUInt64BE(BigInt(2 * cluster) | (1n << 63n), cluster);
  const l2 = (slot: number, entry: bigint) => file.writeBigUInt64BE(entry, 2 * cluster + slot * 8);
  plain.copy(file, 3 * cluster);
  l2(0, BigInt(3 * cluster));
  const compressed = Buffer.concat([deflateRawSync(compressible), Buffer.from("trailing")]);
  const host = 4 * cluster + 100;
  compressed.copy(file, host);
  const sectors = Math.ceil((compressed.length + (host % 512)) / 512);
  l2(1, (1n << 62n) | (BigInt(sectors - 1) << 58n) | BigInt(host));
  if (version === 3) l2(2, BigInt(3 * cluster) | 1n);
  tail.copy(file, 6 * cluster);
  l2(4, BigInt(6 * cluster));
  edit(file);
  return file;
}
async function fixture(run: (source: string, destination: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vectis-qcow2-"));
  try {
    await run(join(directory, "source.qcow2"), join(directory, "disk.img"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([2, 3] as const)("converts qcow2 v%i clusters to a raw disk", (version) =>
  fixture(async (source, destination) => {
    await writeFile(source, image(version));
    await convertQcow2ToRaw(source, destination, size, new AbortController().signal);
    const expected = Buffer.alloc(size);
    plain.copy(expected, 0);
    compressible.copy(expected, cluster);
    tail.copy(expected, 4 * cluster, 0, 200);
    expect(await readFile(destination)).toEqual(expected);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  }),
);

test.each([
  ["backing files", (file: Buffer) => file.writeBigUInt64BE(512n, 8), "unsupported_image"],
  ["encryption", (file: Buffer) => file.writeUInt32BE(1, 32), "unsupported_image"],
  ["snapshots", (file: Buffer) => file.writeUInt32BE(1, 60), "unsupported_image"],
  ["extended L2 entries", (file: Buffer) => file.writeBigUInt64BE(16n, 72), "unsupported_image"],
  ["other formats", (file: Buffer) => file.writeUInt32BE(0, 0), "invalid_image"],
  [
    "corrupt compressed data",
    (file: Buffer) => file.fill(0xff, 4 * cluster + 100, 4 * cluster + 110),
    "invalid_image",
  ],
  [
    "truncated clusters",
    (file: Buffer) => file.writeBigUInt64BE(BigInt(64 * cluster), 2 * cluster + 32),
    "invalid_image",
  ],
])("rejects %s without leaving output", (_name, edit, code) =>
  fixture(async (source, destination) => {
    await writeFile(source, image(3, edit));
    await expect(
      convertQcow2ToRaw(source, destination, size, new AbortController().signal),
    ).rejects.toMatchObject({ code });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  }),
);

test("rejects images larger than the target disk and honors cancellation", () =>
  fixture(async (source, destination) => {
    await writeFile(source, image(3));
    await expect(
      convertQcow2ToRaw(source, destination, size - 1, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_disk_size" });
    await expect(
      convertQcow2ToRaw(source, destination, size, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  }));
