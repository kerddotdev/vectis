import { expect, test, vi } from "vitest";
import { readCacheWrite } from "./cache-write.js";

const run = {
  id: 10,
  run_attempt: 1,
  event: "push",
  head_branch: "main",
  repository: { id: 2 },
  head_repository: { id: 2 },
};
test.each([
  ["default push", {}, true],
  ["schedule", { event: "schedule" }, true],
  ["dispatch", { event: "workflow_dispatch" }, true],
  ["PR", { event: "pull_request" }, false],
  ["PR target", { event: "pull_request_target" }, false],
  ["fork", { head_repository: { id: 3 } }, false],
  ["branch", { head_branch: "feature" }, false],
  ["repository", { repository: { id: 3 } }, false],
  ["run", { id: 11 }, false],
  ["attempt", { run_attempt: 2 }, false],
  ["missing fork identity", { head_repository: null }, false],
] as const)("cache write: %s", async (_name, patch, expected) => {
  const read = vi.fn(async (path: string) =>
    path === "" ? { id: 2, default_branch: "main" } : { ...run, ...patch },
  );
  const result = await readCacheWrite(read, 2, 10, 1);
  expect(result.cacheWrite).toBe(expected);
  expect(result.cacheRun).toEqual(expected ? { runId: 10, runAttempt: 1 } : undefined);
  expect(read).toHaveBeenCalledWith("/actions/runs/10");
});
test("unreadable run and unknown default branch fail closed", async () => {
  expect(
    await readCacheWrite(
      async () => {
        throw new Error("unreadable");
      },
      2,
      10,
    ),
  ).toEqual({ cacheWrite: false });
  expect(await readCacheWrite(async (path) => (path ? run : { id: 2 }), 2, 10)).toEqual({
    cacheWrite: false,
  });
});
