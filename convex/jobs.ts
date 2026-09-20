import { ConvexError, v } from "convex/values";
import { githubJob } from "./githubValidators.js";
import { publicJob, storeJob } from "./jobStore.js";
import type { JobObservations } from "../packages/protocol/src/jobs.js";
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
    return jobs.map(publicJob);
  },
});

export const forLeases = query({
  args: { leaseIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<JobObservations> => {
    const target = await machine(ctx);
    if (args.leaseIds.length > 20) throw new ConvexError({ code: "invalid_lease_ids" });
    const observations: Array<JobObservations[number]> = [];
    for (const leaseId of new Set(args.leaseIds)) {
      const id = ctx.db.normalizeId("runnerLeases", leaseId);
      const lease = id ? await ctx.db.get("runnerLeases", id) : null;
      if (!lease || lease.machineId !== target._id || lease.owner !== target.owner) continue;
      const binding = await ctx.db.get("repositoryBindings", lease.bindingId);
      if (!binding || binding.machineId !== target._id || binding.owner !== target.owner) continue;
      const account = await ctx.db.get("githubAccounts", binding.accountId);
      if (account?.owner !== target.owner) continue;
      const jobs = await ctx.db
        .query("githubJobs")
        .withIndex("by_runner", (q) =>
          q
            .eq("installationId", binding.installationId)
            .eq("repositoryId", binding.repositoryId)
            .eq("runnerName", `vectis-${leaseId}`),
        )
        .take(2);
      const job = jobs[0];
      if (
        !job ||
        jobs.length !== 1 ||
        (lease.runnerId !== undefined && job.runnerId !== null && lease.runnerId !== job.runnerId)
      )
        continue;
      observations.push({ leaseId, job: publicJob(job) });
    }
    return observations;
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
    const id = await storeJob(ctx, args.job, binding.installationId, binding.repositoryId);
    const job = await ctx.db.get("githubJobs", id);
    if (!job) throw new Error("GitHub job persistence failed.");
    return publicJob(job);
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
