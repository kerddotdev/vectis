import { v } from "convex/values";

export const runControlCommand = v.union(
  v.object({ type: v.literal("run.rerun-failed"), bindingId: v.string(), runId: v.number() }),
  v.object({ type: v.literal("run.cancel"), bindingId: v.string(), runId: v.number() }),
  v.object({
    type: v.literal("workflow.dispatch"),
    bindingId: v.string(),
    workflow: v.union(v.string(), v.number()),
    ref: v.string(),
    inputs: v.optional(v.record(v.string(), v.string())),
  }),
);
export const runControlOutcome = v.union(
  v.object({
    state: v.literal("accepted"),
    message: v.string(),
    runId: v.optional(v.number()),
    runAttempt: v.optional(v.number()),
    htmlUrl: v.optional(v.string()),
  }),
  v.object({
    state: v.literal("uncertain"),
    code: v.literal("run_command_unconfirmed"),
    message: v.string(),
    nextStep: v.string(),
    runId: v.optional(v.number()),
    runAttempt: v.optional(v.number()),
    htmlUrl: v.optional(v.string()),
  }),
  v.object({
    state: v.literal("rejected"),
    code: v.string(),
    message: v.string(),
    nextStep: v.string(),
  }),
);
