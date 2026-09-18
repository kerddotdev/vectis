import { v } from "convex/values";
export const installation = v.object({ id: v.number(), accountId: v.number(), login: v.string() });
export const verifiedUser = v.object({
  id: v.number(),
  login: v.string(),
  installations: v.array(installation),
});

export const githubJob = v.object({
  id: v.number(),
  run_id: v.number(),
  name: v.string(),
  status: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
  conclusion: v.union(v.string(), v.null()),
  labels: v.array(v.string()),
  runner_id: v.union(v.number(), v.null()),
  runner_name: v.union(v.string(), v.null()),
});
