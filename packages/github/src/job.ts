import { Schema } from "effect";

export const GitHubJob = Schema.Struct({
  id: Schema.Int,
  run_id: Schema.Int,
  name: Schema.String.check(Schema.isMaxLength(200)),
  html_url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  workflow_name: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  status: Schema.Literals(["queued", "in_progress", "completed"]),
  conclusion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  labels: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(100)),
  runner_id: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  runner_name: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
});
export type GitHubJob = typeof GitHubJob.Type;
