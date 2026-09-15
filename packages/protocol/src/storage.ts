import { Schema } from "effect";

export const StorageUsage = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["available", "missing", "unavailable"]),
  fileBytes: Schema.optional(Schema.Number),
  allocatedBytes: Schema.optional(Schema.Number),
  virtualCapacityBytes: Schema.optional(Schema.Number),
  entries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        fileBytes: Schema.Number,
        allocatedBytes: Schema.Number,
      }),
    ),
  ),
  reason: Schema.optional(Schema.String),
});
export type StorageUsage = typeof StorageUsage.Type;
export const StorageReport = Schema.Struct({
  measuredAt: Schema.String,
  allocationNote: Schema.String,
  environments: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      base: StorageUsage,
      instances: Schema.Array(Schema.Struct({ id: Schema.String, usage: StorageUsage })),
      guestBreakdown: Schema.Literal("unavailable"),
    }),
  ),
});
export type StorageReport = typeof StorageReport.Type;
