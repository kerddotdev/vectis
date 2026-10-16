import { expect, test } from "vitest";
import { estimatedVmMemoryMiB, parseAvailableMemory } from "./memory.js";

test.each([
  { os: "linux", memoryMiB: 12288, expected: 2048 },
  { os: "macos", memoryMiB: 12288, expected: 4096 },
  { os: "windows", memoryMiB: 16384, expected: 4096 },
  { os: "linux", memoryMiB: 512, expected: 512 },
  { os: "macos", memoryMiB: 2048, expected: 2048 },
  { os: "windows", memoryMiB: 1024, expected: 1024 },
] as const)(
  "$os startup estimate respects its $memoryMiB MiB ceiling",
  ({ os, memoryMiB, expected }) => {
    expect(estimatedVmMemoryMiB({ os, memoryMiB })).toBe(expected);
  },
);

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
