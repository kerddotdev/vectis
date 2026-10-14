import { internal } from "./_generated/api.js";
import { restrictiveAccess } from "../packages/github/src/access-policy.js";
import { storeJob } from "./jobStore.js";
import { githubJob } from "./githubValidators.js";
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
    job: v.optional(githubJob),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (existing) return { duplicate: true };
    const { job: input, ...delivery } = args;
    if (input && args.event === "workflow_job" && args.repositoryId && args.installationId) {
      await storeJob(ctx, input, args.installationId, args.repositoryId);
      const installationId = args.installationId;
      const repositoryId = args.repositoryId;
      const bindings = await ctx.db
        .query("repositoryBindings")
        .withIndex("by_repository", (q) =>
          q
            .eq("installationId", installationId)
            .eq("repositoryId", repositoryId)
            .eq("enabled", true),
        )
        .take(100);
      if (bindings.some((binding) => restrictiveAccess(binding.access)))
        await ctx.scheduler.runAfter(0, internal.githubJobs.enrichWebhook, {
          installationId: args.installationId,
          repositoryId: args.repositoryId,
          job: input,
        });
    }
    await ctx.db.insert("githubDeliveries", { ...delivery, receivedAt: Date.now() });
    return { duplicate: false };
  },
});
