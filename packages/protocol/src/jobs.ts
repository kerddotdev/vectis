import { Schema } from "effect";
import { Identifier } from "./identifier.js";

export const Job = Schema.Struct({
  jobId: Schema.Int,
  runId: Schema.Int,
  runAttempt: Schema.optional(Schema.Int),
  actorId: Schema.optional(Schema.Int),
  triggeringActorId: Schema.optional(Schema.Int),
  access: Schema.optional(
    Schema.Literals(["approval_required", "actor_not_allowed", "actor_unknown"]),
  ),
  name: Schema.String,
  htmlUrl: Schema.optional(Schema.String),
  workflowName: Schema.optional(Schema.String),
  status: Schema.Literals(["waiting", "queued", "in_progress", "completed"]),
  conclusion: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  runnerId: Schema.NullOr(Schema.Int),
  runnerName: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type Job = typeof Job.Type;

export const Jobs = Schema.Array(Job);
export type Jobs = typeof Jobs.Type;

export const JobRefresh = Job;
export type JobRefresh = typeof JobRefresh.Type;

export const JobObservations = Schema.Array(Schema.Struct({ leaseId: Schema.String, job: Job }));
export type JobObservations = typeof JobObservations.Type;

export const JobScan = Schema.Struct({
  runs: Schema.Int,
  jobs: Schema.Int,
  complete: Schema.Boolean,
});
export type JobScan = typeof JobScan.Type;

export const JobLogRequest = Schema.Struct({
  bindingId: Identifier,
  jobId: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  after: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
});
export type JobLogRequest = typeof JobLogRequest.Type;

export const JobLogs = Schema.Struct({
  text: Schema.String,
  next: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  status: Job.fields.status,
  complete: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type JobLogs = typeof JobLogs.Type;
