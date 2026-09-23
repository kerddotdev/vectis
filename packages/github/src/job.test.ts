import { Schema } from "effect";
import { expect, test } from "vitest";
import { GitHubJob } from "./job.js";

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
  expect(() => decode({ ...job, [field]: "a".repeat(limit + 1) })).toThrow();
});
