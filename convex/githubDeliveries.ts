import { Schema } from "effect";
import { GitHubJob } from "../packages/github/src/job.js";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
export const accept = internalMutation({
  args: {
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    repositoryId: v.optional(v.number()),
    installationId: v.optional(v.number()),
    jobId: v.optional(v.number()),
    job: v.optional(
      v.object({
        id: v.number(),
        run_id: v.number(),
        name: v.string(),
        status: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
        conclusion: v.union(v.string(), v.null()),
        labels: v.array(v.string()),
        runner_id: v.union(v.number(), v.null()),
        runner_name: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (existing) return { duplicate: true };
    const { job: input, ...delivery } = args;
    if (input && args.event === "workflow_job" && args.repositoryId && args.installationId) {
      const job = Schema.decodeUnknownSync(GitHubJob)(input);
      const installationId = args.installationId;
      const repositoryId = args.repositoryId;
      const previous = await ctx.db
        .query("githubJobs")
        .withIndex("by_job", (q) =>
          q
            .eq("installationId", installationId)
            .eq("repositoryId", repositoryId)
            .eq("jobId", job.id),
        )
        .unique();
      const order = { queued: 0, in_progress: 1, completed: 2 };
      if (!previous || order[job.status] >= order[previous.status]) {
        const record = {
          installationId: args.installationId,
          repositoryId: args.repositoryId,
          jobId: job.id,
          runId: job.run_id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          labels: [...job.labels],
          runnerId: job.runner_id,
          runnerName: job.runner_name,
          updatedAt: Date.now(),
        };
        if (previous) await ctx.db.patch("githubJobs", previous._id, record);
        else await ctx.db.insert("githubJobs", record);
      }
    }
    await ctx.db.insert("githubDeliveries", { ...delivery, receivedAt: Date.now() });
    return { duplicate: false };
  },
});
