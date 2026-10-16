import { Schema, SchemaGetter } from "effect";

const StoredJob = Schema.Struct({
  id: Schema.Int,
  run_id: Schema.Int,
  run_attempt: Schema.optionalKey(Schema.Int),
  actor_id: Schema.optionalKey(Schema.Int),
  triggering_actor_id: Schema.optionalKey(Schema.Int),
  name: Schema.String.check(Schema.isMaxLength(200)),
  html_url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  workflow_name: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  status: Schema.Literals([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  labels: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(100)),
  runner_id: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  runner_name: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
});
const IncomingJob = Schema.Struct({
  ...StoredJob.fields,
  name: Schema.String,
  html_url: Schema.optionalKey(Schema.String),
  workflow_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  runner_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

// This label cannot belong to a Vectis runner. Never turn a lossy label list into runnable demand.
export const unmatchableLabels = "vectis:unmatchable-labels";
export const GitHubJob = IncomingJob.pipe(
  Schema.decodeTo(StoredJob, {
    decode: SchemaGetter.transform((job) => {
      const { html_url, ...metadata } = job;
      const invalidLabels =
        job.labels.length > 100 || job.labels.some((label) => label.length > 100);
      return {
        ...metadata,
        name: job.name.slice(0, 200),
        ...(html_url !== undefined && html_url.length <= 500 ? { html_url } : {}),
        ...(job.workflow_name == null ? {} : { workflow_name: job.workflow_name.slice(0, 200) }),
        status: Schema.is(StoredJob.fields.status)(job.status) ? job.status : "waiting",
        conclusion: job.conclusion?.slice(0, 80) ?? null,
        labels: invalidLabels
          ? [...job.labels.slice(0, 99).map((label) => label.slice(0, 100)), unmatchableLabels]
          : job.labels,
        ...(job.runner_name == null ? {} : { runner_name: job.runner_name.slice(0, 200) }),
      };
    }),
    encode: SchemaGetter.transform((job) => job),
  }),
);
export type GitHubJob = typeof GitHubJob.Type;
