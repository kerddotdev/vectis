import { redact } from "../../../packages/client/src/redact.js";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceLog } from "../../../packages/protocol/src/logs.js";

const tailBytes = 128 * 1024;

export async function readServiceLog(home: string, lines: number): Promise<ServiceLog> {
  let file;
  try {
    file = await open(join(home, "service.log"), "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { lines: [], truncated: false };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const newline = text.indexOf("\n");
    const tail = start > 0 ? (newline < 0 ? "" : text.slice(newline + 1)) : text;
    const all = redact(tail).split("\n");
    if (all.at(-1) === "") all.pop();
    return { lines: all.slice(-lines), truncated: start > 0 || all.length > lines };
  } finally {
    await file.close();
  }
}
