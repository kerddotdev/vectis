import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server.js";
import { machine } from "./auth.js";

export const list = query({
  args: { bindingId: v.string() },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const id = ctx.db.normalizeId("repositoryBindings", args.bindingId);
    const binding = id ? await ctx.db.get("repositoryBindings", id) : null;
    if (
      !binding ||
      !binding.enabled ||
      binding.machineId !== target._id ||
      binding.owner !== target.owner
    )
      throw new ConvexError({ code: "repository_access_denied" });
    const account = await ctx.db.get("githubAccounts", binding.accountId);
    if (account?.owner !== target.owner)
      throw new ConvexError({ code: "repository_access_denied" });
    const jobs = await ctx.db
      .query("githubJobs")
      .withIndex("by_repository", (q) =>
        q.eq("installationId", binding.installationId).eq("repositoryId", binding.repositoryId),
      )
      .order("desc")
      .take(100);
    return jobs.map(
      ({ jobId, runId, name, status, conclusion, labels, runnerId, runnerName, updatedAt }) => ({
        jobId,
        runId,
        name,
        status,
        conclusion,
        labels,
        runnerId,
        runnerName,
        updatedAt,
      }),
    );
  },
});
