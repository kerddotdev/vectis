import { expect, test } from "vitest";
import { scanRepositoryJobs } from "./job-scan.js";
const job = (id: number, runId: number) => ({
  id,
  run_id: runId,
  name: "Build",
  status: "queued" as const,
  conclusion: null,
  labels: ["vectis-linux"],
  runner_id: null,
  runner_name: null,
});
test("discovers missing jobs, paginates and revisits known runs after completion", async () => {
  const paths: string[] = [];
  const saved: number[] = [];
  const result = await scanRepositoryJobs(
    async (path) => {
      paths.push(path);
      if (path.includes("status=queued"))
        return { total_count: 51, workflow_runs: [{ id: path.includes("page=1") ? 10 : 11 }] };
      if (path.includes("status=in_progress"))
        return { total_count: 1, workflow_runs: [{ id: 10 }] };
      const run = path.includes("/9/") ? 9 : path.includes("/10/") ? 10 : 11;
      return {
        total_count: run === 10 ? 51 : 1,
        jobs: [job(path.includes("page=2") ? 12 : run, run)],
      };
    },
    async (batch) => {
      saved.push(...batch.map((item) => item.id));
    },
    [9],
  );
  expect(result).toEqual({ runs: 3, jobs: 4, complete: true });
  expect(saved).toEqual([9, 10, 12, 11]);
  expect(paths).toHaveLength(7);
});
test("reports incomplete work when the API budget is exhausted", async () => {
  const result = await scanRepositoryJobs(
    async () => ({ total_count: 100, workflow_runs: [{ id: 10 }] }),
    async () => {},
    [],
    1,
  );
  expect(result).toEqual({ runs: 0, jobs: 0, complete: false });
});
test("rejects mismatched run identity before saving jobs", async () => {
  let saved = false;
  await expect(
    scanRepositoryJobs(
      async (path) =>
        path.includes("/jobs?")
          ? { total_count: 1, jobs: [job(4, 999)] }
          : { total_count: 1, workflow_runs: [{ id: 10 }] },
      async () => {
        saved = true;
      },
      [],
    ),
  ).rejects.toThrow("different workflow");
  expect(saved).toBe(false);
});
