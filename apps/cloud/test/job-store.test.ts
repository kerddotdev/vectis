import { beforeEach, expect, it } from "vitest";
import { env } from "../src/test-support.js";
import { mergeJob, storeJob } from "../src/github/job-store.js";
import type { GitHubJob } from "../../../packages/github/src/job.js";

const job: GitHubJob & { installationId: number; repositoryId: number; updatedAt: number } = {
  installationId: 10,
  repositoryId: 100,
  updatedAt: 100,
  id: 1,
  run_id: 2,
  run_attempt: 1,
  name: "build",
  status: "queued",
  conclusion: null,
  labels: ["self-hosted"],
};
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM githubDeliveries"),
    env.DB.prepare("DELETE FROM githubJobs"),
  ]);
});
it("keeps status monotonic and fills metadata on stale reports", () => {
  const completed = mergeJob(null, {
    ...job,
    status: "completed",
    conclusion: "success",
    actor_id: 10,
  });
  const stale = mergeJob(completed, { ...job, runner_id: 4, html_url: "https://github.test/job" });
  expect(stale).toMatchObject({
    status: "completed",
    conclusion: "success",
    actorId: 10,
    runnerId: 4,
    htmlUrl: "https://github.test/job",
  });
  expect(stale.updatedAt).toBeGreaterThan(completed.updatedAt);
  expect(mergeJob(stale, { ...job, status: "completed", conclusion: "success" })).toBe(stale);
});
it("clears actors across attempts and treats requested as waiting", () => {
  const previous = mergeJob(null, { ...job, actor_id: 10 });
  expect(mergeJob(previous, { ...job, run_attempt: 2, status: "requested" })).toMatchObject({
    actorId: null,
    runAttempt: 2,
    status: "waiting",
  });
});
it("retries competing inserts without regressing completion", async () => {
  await Promise.all([
    storeJob(env, job, 10, 100),
    storeJob(env, { ...job, status: "completed", conclusion: "success" }, 10, 100),
  ]);
  expect(await env.DB.prepare("SELECT status FROM githubJobs").first()).toEqual({
    status: "completed",
  });
});
it("commits a delivery and job together and ignores changed duplicate payloads", async () => {
  const delivery = {
    deliveryId: "same",
    event: "workflow_job",
    action: "queued",
    repositoryId: 100,
    installationId: 10,
    jobId: 1,
    receivedAt: Date.now(),
  };
  const results = await Promise.all([
    storeJob(env, job, 10, 100, delivery),
    storeJob(env, job, 10, 100, delivery),
  ]);
  expect(results.filter((result) => result.duplicate)).toHaveLength(1);
  const before = await env.DB.prepare("SELECT * FROM githubJobs").first();
  expect((await storeJob(env, { ...job, status: "completed" }, 10, 100, delivery)).duplicate).toBe(
    true,
  );
  expect(await env.DB.prepare("SELECT * FROM githubJobs").first()).toEqual(before);
});
