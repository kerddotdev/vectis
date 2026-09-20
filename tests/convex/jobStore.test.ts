import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { storeJob } from "../../convex/jobStore.js";
import type { GitHubJob } from "../../packages/github/src/job.js";

const modules = {
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const completed: GitHubJob = {
  id: 1,
  run_id: 2,
  name: "Build",
  status: "completed",
  conclusion: "failure",
  labels: ["vectis-linux"],
  runner_id: 3,
  runner_name: "vectis-lease",
};
afterEach(() => vi.restoreAllMocks());

test("late observations fill missing metadata without regressing job state or runner identity", async () => {
  const t = convexTest(schema, modules);
  const id = await t.run((ctx) => storeJob(ctx, completed, 4, 5));
  const metadata = {
    html_url: "https://github.com/test/repo/actions/runs/2/job/1",
    workflow_name: "CI",
  };
  await t.run((ctx) =>
    storeJob(
      ctx,
      {
        ...completed,
        ...metadata,
        name: "Old name",
        status: "queued",
        conclusion: null,
        runner_id: null,
        runner_name: null,
        labels: [],
      },
      4,
      5,
    ),
  );
  expect(await t.run((ctx) => ctx.db.get("githubJobs", id))).toMatchObject({
    name: "Build",
    status: "completed",
    conclusion: "failure",
    labels: ["vectis-linux"],
    runnerId: 3,
    runnerName: "vectis-lease",
    htmlUrl: metadata.html_url,
    workflowName: "CI",
  });
  await t.run((ctx) =>
    storeJob(
      ctx,
      {
        id: 1,
        run_id: 2,
        name: "Build",
        status: "completed",
        conclusion: null,
        labels: ["vectis-linux"],
        workflow_name: null,
      },
      4,
      5,
    ),
  );
  expect(await t.run((ctx) => ctx.db.get("githubJobs", id))).toMatchObject({
    conclusion: "failure",
    runnerId: 3,
    runnerName: "vectis-lease",
    htmlUrl: metadata.html_url,
    workflowName: "CI",
  });
});

test("identical API and webhook observations do not rewrite the row", async () => {
  const t = convexTest(schema, modules);
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const id = await t.run((ctx) => storeJob(ctx, completed, 4, 5));
  const before = await t.run((ctx) => ctx.db.get("githubJobs", id));
  now.mockReturnValue(2000);
  await t.run((ctx) => storeJob(ctx, { ...completed, labels: [...completed.labels] }, 4, 5));
  expect(await t.run((ctx) => ctx.db.get("githubJobs", id))).toEqual(before);
});
