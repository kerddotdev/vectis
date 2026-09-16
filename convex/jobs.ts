import { ConvexError, v } from "convex/values";
import { githubJob } from "./githubValidators.js";
import { storeJob } from "./jobStore.js";
import type { QueryCtx } from "./_generated/server.js";
import { internalMutation, internalQuery, query } from "./_generated/server.js";
import { machine } from "./auth.js";

export const list = query({
  args: { bindingId: v.string() },
  handler: async (ctx, args) => {
    const binding = await jobBinding(ctx, args.bindingId);
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

async function jobBinding(ctx: QueryCtx, bindingId: string) {
  const target = await machine(ctx);
  const id = ctx.db.normalizeId("repositoryBindings", bindingId);
  const binding = id ? await ctx.db.get("repositoryBindings", id) : null;
  if (
    !binding ||
    !binding.enabled ||
    binding.machineId !== target._id ||
    binding.owner !== target.owner
  )
    throw new ConvexError({ code: "repository_access_denied" });
  const account = await ctx.db.get("githubAccounts", binding.accountId);
  if (account?.owner !== target.owner) throw new ConvexError({ code: "repository_access_denied" });
  return binding;
}

export const save = internalMutation({
  args: {
    bindingId: v.string(),
    installationId: v.number(),
    repositoryId: v.number(),
    job: githubJob,
  },
  handler: async (ctx, args) => {
    const binding = await jobBinding(ctx, args.bindingId);
    if (
      binding.installationId !== args.installationId ||
      binding.repositoryId !== args.repositoryId
    )
      throw new ConvexError({ code: "repository_access_changed" });
    await storeJob(ctx, args.job, binding.installationId, binding.repositoryId);
  },
});

export const pendingRuns = internalQuery({
  args: { bindingId: v.string() },
  handler: async (ctx, args) => {
    const binding = await jobBinding(ctx, args.bindingId);
    const ids = new Set<number>();
    let complete = true;
    for (const status of ["queued", "in_progress"] as const) {
      const jobs = await ctx.db
        .query("githubJobs")
        .withIndex("by_repository_status", (q) =>
          q
            .eq("installationId", binding.installationId)
            .eq("repositoryId", binding.repositoryId)
            .eq("status", status),
        )
        .take(101);
      if (jobs.length > 100) complete = false;
      for (const job of jobs.slice(0, 100)) ids.add(job.runId);
    }
    return { runIds: [...ids], complete };
  },
});

export const savePage = internalMutation({
  args: {
    bindingId: v.string(),
    installationId: v.number(),
    repositoryId: v.number(),
    jobs: v.array(githubJob),
  },
  handler: async (ctx, args) => {
    const binding = await jobBinding(ctx, args.bindingId);
    if (
      binding.installationId !== args.installationId ||
      binding.repositoryId !== args.repositoryId ||
      args.jobs.length > 50
    )
      throw new ConvexError({ code: "repository_access_changed" });
    for (const job of args.jobs)
      await storeJob(ctx, job, binding.installationId, binding.repositoryId);
  },
});
