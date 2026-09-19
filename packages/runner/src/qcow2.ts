import { constants } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { VectisError } from "../../protocol/src/index.js";

const inflate = promisify(inflateRaw);
const offsetMask = 0x00ff_ffff_ffff_fe00n;
const compressedFlag = 1n << 62n;
const dirtyFlag = 1n;

function invalid(message: string): never {
  throw new VectisError("invalid_image", message);
}
function unsupported(message: string): never {
  throw new VectisError("unsupported_image", message);
}
function position(value: bigint, alignment = 1n) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value % alignment)
    invalid("The qcow2 image references an invalid offset.");
  return Number(value);
}
async function read(file: FileHandle, length: number, at: number, allowShort = false) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, at + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  if (filled < length && !allowShort) invalid("The qcow2 image is truncated.");
  return buffer.subarray(0, filled);
}
async function write(file: FileHandle, data: Buffer, at: number) {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await file.write(data, written, data.length - written, at + written);
    if (!bytesWritten)
      throw new VectisError("image_write_failed", "Image storage made no progress.");
    written += bytesWritten;
  }
}

export async function convertQcow2ToRaw(
  source: string,
  destination: string,
  maxBytes: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = await read(input, 104, 0);
    if (header.readUInt32BE(0) !== 0x514649fb) invalid("The source image is not qcow2.");
    const version = header.readUInt32BE(4);
    if (version !== 2 && version !== 3) unsupported(`qcow2 version ${version} is not supported.`);
    if (header.readBigUInt64BE(8))
      unsupported("qcow2 images with backing files are not supported.");
    const clusterBits = header.readUInt32BE(20);
    if (clusterBits < 9 || clusterBits > 21) invalid("The qcow2 cluster size is invalid.");
    if (header.readUInt32BE(32)) unsupported("Encrypted qcow2 images are not supported.");
    if (header.readUInt32BE(60)) unsupported("qcow2 images with snapshots are not supported.");
    if (version === 3 && header.readBigUInt64BE(72) & ~dirtyFlag)
      unsupported("The qcow2 image uses unsupported features.");
    const size = position(header.readBigUInt64BE(24));
    if (size > maxBytes)
      throw new VectisError(
        "invalid_disk_size",
        "The target disk is smaller than the source image.",
      );
    const clusterSize = 2 ** clusterBits;
    const entries = clusterSize / 8;
    const l1Size = header.readUInt32BE(36);
    if (l1Size * entries * clusterSize < size || l1Size * 8 > 32 * 1024 ** 2)
      invalid("The qcow2 L1 table size is invalid.");
    const l1 = await read(input, l1Size * 8, position(header.readBigUInt64BE(40), 8n));
    const zero = Buffer.alloc(clusterSize);
    const sizeShift = BigInt(62 - (clusterBits - 8));
    const sectorMask = (1n << BigInt(clusterBits - 8)) - 1n;

    async function cluster(entry: bigint, length: number) {
      if (entry & compressedFlag) {
        const host = entry & ((1n << sizeShift) - 1n);
        const sectors = Number((entry >> sizeShift) & sectorMask) + 1;
        const data = await read(input, sectors * 512 - Number(host % 512n), position(host), true);
        const plain = await inflate(data, { maxOutputLength: clusterSize }).catch(() =>
          invalid("A compressed qcow2 cluster could not be decompressed."),
        );
        if (plain.length !== clusterSize) invalid("A compressed qcow2 cluster has the wrong size.");
        return plain.subarray(0, length);
      }
      if (version === 3 && entry & 1n) return undefined;
      const host = entry & offsetMask;
      return host ? read(input, length, position(host, BigInt(clusterSize))) : undefined;
    }

    const output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let complete = false;
    try {
      await output.truncate(size);
      for (let index = 0; index < l1Size; index++) {
        const l2Offset = l1.readBigUInt64BE(index * 8) & offsetMask;
        if (!l2Offset) continue;
        const l2 = await read(input, clusterSize, position(l2Offset, BigInt(clusterSize)));
        for (let slot = 0; slot < entries; slot++) {
          const guest = (index * entries + slot) * clusterSize;
          if (guest >= size) break;
          signal.throwIfAborted();
          const length = Math.min(clusterSize, size - guest);
          const data = await cluster(l2.readBigUInt64BE(slot * 8), length);
          if (data && !data.equals(zero.subarray(0, length))) await write(output, data, guest);
        }
      }
      await output.sync();
      complete = true;
    } finally {
      await output.close();
      if (!complete) await rm(destination, { force: true });
    }
  } finally {
    await input.close();
  }
}
