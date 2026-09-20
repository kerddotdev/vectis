import { Schema } from "effect";

export const Job = Schema.Struct({
  jobId: Schema.Int,
  runId: Schema.Int,
  name: Schema.String,
  htmlUrl: Schema.optional(Schema.String),
  workflowName: Schema.optional(Schema.String),
  status: Schema.Literals(["queued", "in_progress", "completed"]),
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
