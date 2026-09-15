import { expect, test } from "vitest";
import { parseAvailableMemory } from "./memory.js";

test("includes reclaimable inactive pages without double-counting file-backed pages", () => {
  const statistics =
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 10.\nFile-backed pages: 205.\n";
  expect(parseAvailableMemory(statistics)).toBe(310 * 16384);
});
test("rejects missing or malformed capacity data", () => {
  expect(parseAvailableMemory("Pages free: 100.")).toBeUndefined();
  expect(
    parseAvailableMemory(
      "page size of 16384 bytes\nPages free: -1.\nPages inactive: 2.\nPages speculative: 3.",
    ),
  ).toBeUndefined();
});
