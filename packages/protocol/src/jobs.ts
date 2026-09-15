import { Schema } from "effect";

export const Jobs = Schema.Array(
  Schema.Struct({
    jobId: Schema.Int,
    runId: Schema.Int,
    name: Schema.String,
    status: Schema.Literals(["queued", "in_progress", "completed"]),
    conclusion: Schema.NullOr(Schema.String),
    labels: Schema.Array(Schema.String),
    runnerId: Schema.NullOr(Schema.Int),
    runnerName: Schema.NullOr(Schema.String),
    updatedAt: Schema.Number,
  }),
);
export type Jobs = typeof Jobs.Type;
