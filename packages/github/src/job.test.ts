import { Schema } from "effect";
import { expect, test } from "vitest";
import { GitHubJob, unmatchableLabels } from "./job.js";

const job = { id: 1, run_id: 2, name: "Build", status: "queued", conclusion: null, labels: [] };

test("historical payloads and nullable workflow names still decode", () => {
  expect(Schema.decodeUnknownSync(GitHubJob)(job)).toEqual(job);
  expect(Schema.decodeUnknownSync(GitHubJob)({ ...job, workflow_name: null })).toEqual({
    ...job,
    workflow_name: null,
  });
});

test.each([
  ["html_url", 500],
  ["workflow_name", 200],
] as const)("%s is bounded", (field, limit) => {
  const decode = Schema.decodeUnknownSync(GitHubJob);
  expect(decode({ ...job, [field]: "a".repeat(limit) })).toHaveProperty(field, "a".repeat(limit));
  const bounded = decode({ ...job, [field]: "a".repeat(limit + 1) });
  if (field === "html_url") expect(bounded).not.toHaveProperty(field);
  else expect(bounded).toHaveProperty(field, "a".repeat(limit));
});

test("unknown status waits for the next API scan without becoming runner demand", () => {
  expect(Schema.decodeUnknownSync(GitHubJob)({ ...job, status: "future_status" }).status).toBe(
    "waiting",
  );
});

test.each([
  { labels: Array.from({ length: 101 }, () => "vectis-linux") },
  { labels: ["a".repeat(101), "vectis-linux"] },
])("lossy label lists carry an unmatchable marker", ({ labels }) => {
  const decoded = Schema.decodeUnknownSync(GitHubJob)({ ...job, labels });
  expect(decoded.labels).toContain(unmatchableLabels);
  expect(decoded.labels.length).toBeLessThanOrEqual(100);
  expect(decoded.labels.every((label) => label.length <= 100)).toBe(true);
  expect(Schema.decodeUnknownSync(GitHubJob)(decoded)).toEqual(decoded);
});

test("bounds display strings while preserving job and runner identity", () => {
  expect(
    Schema.decodeUnknownSync(GitHubJob)({
      ...job,
      name: "n".repeat(300),
      runner_id: 5,
      runner_name: "r".repeat(300),
      conclusion: "c".repeat(100),
    }),
  ).toMatchObject({
    id: 1,
    run_id: 2,
    name: "n".repeat(200),
    runner_id: 5,
    runner_name: "r".repeat(200),
    conclusion: "c".repeat(80),
  });
});
