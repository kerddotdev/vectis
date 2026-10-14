import { v } from "convex/values";
export const installation = v.object({ id: v.number(), accountId: v.number(), login: v.string() });
export const verifiedUser = v.object({
  id: v.number(),
  login: v.string(),
  installations: v.array(installation),
});

export const repositoryAccess = v.object({
  actors: v.union(v.literal("any"), v.object({ ids: v.array(v.number()) })),
  approval: v.union(v.literal("automatic"), v.literal("required")),
});
export const runnerAccess = v.object({
  repositoryId: v.number(),
  ...repositoryAccess.fields,
  approvedRun: v.optional(v.object({ runId: v.number(), runAttempt: v.number() })),
});

export const githubJob = v.object({
  id: v.number(),
  run_id: v.number(),
  run_attempt: v.optional(v.number()),
  actor_id: v.optional(v.number()),
  triggering_actor_id: v.optional(v.number()),
  name: v.string(),
  html_url: v.optional(v.string()),
  workflow_name: v.optional(v.union(v.string(), v.null())),
  status: v.union(
    v.literal("queued"),
    v.literal("in_progress"),
    v.literal("completed"),
    v.literal("waiting"),
    v.literal("requested"),
    v.literal("pending"),
  ),
  conclusion: v.union(v.string(), v.null()),
  labels: v.array(v.string()),
  runner_id: v.optional(v.union(v.number(), v.null())),
  runner_name: v.optional(v.union(v.string(), v.null())),
});
