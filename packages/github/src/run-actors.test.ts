import { expect, test, vi } from "vitest";
import { readRunActors, withRunActors } from "./run-actors.js";
import type { GitHubJob } from "./job.js";

const run = {
  id: 5,
  run_attempt: 2,
  repository: { id: 2 },
  actor: { id: 7, login: "old-login" },
  triggering_actor: { id: 8, login: "new-login" },
};

test("run actors come from numeric IDs and are bound to the repository and attempt", async () => {
  const read = vi.fn(async () => run);
  const actors = await readRunActors(read, 2, 5);
  expect(read).toHaveBeenCalledWith("/actions/runs/5");
  expect(actors).toEqual({ run_attempt: 2, actor_id: 7, triggering_actor_id: 8 });
  const job: GitHubJob = {
    id: 4,
    run_id: 5,
    run_attempt: 1,
    name: "Build",
    status: "queued",
    conclusion: null,
    labels: ["vectis-linux"],
  };
  expect(() => withRunActors(job, actors)).toThrow("different run attempt");
});

test.each([
  { ...run, id: 6 },
  { ...run, repository: { id: 99 } },
  { ...run, actor: { id: 0 } },
  { ...run, triggering_actor: { login: "new-login" } },
  { ...run, triggering_actor: { id: 1.5 } },
  { ...run, run_attempt: 0 },
])("unrelated or incomplete run data cannot supply actor authority", async (payload) => {
  await expect(readRunActors(async () => payload, 2, 5)).rejects.toThrow();
});
