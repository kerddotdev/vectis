import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { decodeCommand } from "../packages/protocol/src/index.js";
import { matchesRunnerLabels } from "../packages/github/src/runner-labels.js";

export const forRepository = internalMutation({
  args: { installationId: v.number(), repositoryId: v.number() },
  handler: async (ctx, { installationId, repositoryId }) => {
    const bindings = await ctx.db
      .query("repositoryBindings")
      .withIndex("by_automatic_repository", (q) =>
        q
          .eq("installationId", installationId)
          .eq("repositoryId", repositoryId)
          .eq("enabled", true)
          .eq("automatic", true),
      )
      .take(100);
    // Each machine's bounded scan gets its own transaction, including after batched job imports.
    for (const machineId of new Set(bindings.map((binding) => binding.machineId)))
      await ctx.scheduler.runAfter(0, internal.runnerDemand.forMachine, { machineId });
  },
});

export const forMachine = internalMutation({
  args: { machineId: v.id("machines") },
  handler: (ctx, { machineId }) => scheduleRunnerDemand(ctx, machineId),
});

export async function scheduleRunnerDemand(ctx: MutationCtx, machineId: Id<"machines">) {
  const target = await ctx.db.get("machines", machineId);
  if (!target || target.paused !== false || (target.lastSeenAt ?? 0) < Date.now() - 60000) return;
  const legacy = target.runnerSlots === undefined;
  let free = target.runnerSlots ?? (target.runnerIdle === true ? 1 : 0);
  if (free <= 0) return;
  for (const phase of ["accepted", "claimed", "running"] as const) {
    const operations = await ctx.db
      .query("operations")
      .withIndex("by_machine_phase", (q) => q.eq("machineId", machineId).eq("phase", phase))
      .take(100);
    for (const operation of operations) {
      const command = decodeCommand(JSON.parse(operation.commandJson));
      if (command.type !== "runner.run") continue;
      if (legacy) return;
      // Claim precedes local submission; running can precede the next capacity heartbeat.
      if (
        command.automatic &&
        (phase !== "running" || operation.updatedAt >= (target.lastSeenAt ?? 0))
      )
        free--;
    }
    if (free <= 0) return;
  }
  if (legacy) {
    for (const phase of ["preparing", "ready", "action_required"] as const) {
      if (
        await ctx.db
          .query("runnerLeases")
          .withIndex("by_machine_phase", (q) => q.eq("machineId", machineId).eq("phase", phase))
          .first()
      )
        return;
    }
  }
  const bindings = await ctx.db
    .query("repositoryBindings")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .take(100);
  const queues: Array<{ binding: Doc<"repositoryBindings">; jobs: Doc<"githubJobs">[] }> = [];
  for (const binding of bindings) {
    if (!binding.enabled || !binding.automatic || binding.owner !== target.owner) continue;
    const account = await ctx.db.get("githubAccounts", binding.accountId);
    if (account?.owner !== target.owner) continue;
    const environment = target.environments?.find(
      (item) => item.id === binding.environmentId && item.state === "ready",
    );
    if (!environment) continue;
    const jobs = await ctx.db
      .query("githubJobs")
      .withIndex("by_repository_queue", (q) =>
        q
          .eq("installationId", binding.installationId)
          .eq("repositoryId", binding.repositoryId)
          .eq("status", "queued"),
      )
      .take(50);
    queues.push({
      binding,
      jobs: jobs.filter((job) => matchesRunnerLabels(job.labels, environment.os, environment.id)),
    });
  }
  while (free > 0) {
    let scheduled = false;
    for (const { binding, jobs } of queues) {
      if (free <= 0) break;
      while (jobs.length > 0) {
        const job = jobs.shift();
        if (!job) break;
        const demand = await ctx.db
          .query("runnerDemands")
          .withIndex("by_job", (q) =>
            q
              .eq("installationId", binding.installationId)
              .eq("repositoryId", binding.repositoryId)
              .eq("jobId", job.jobId),
          )
          .unique();
        if (demand) {
          if (demand.owner !== target.owner || demand.attempt >= 3) continue;
          const previous = await ctx.db.get("operations", demand.operationId);
          if (previous?.phase !== "succeeded") continue;
        }
        const attempt = (demand?.attempt ?? 0) + 1;
        const now = Date.now();
        const operationId = await ctx.db.insert("operations", {
          owner: target.owner,
          machineId,
          key: `automatic:${binding.installationId}:${binding.repositoryId}:${job.jobId}:${attempt}`,
          commandJson: JSON.stringify({
            type: "runner.run",
            bindingId: binding._id,
            jobId: job.jobId,
            automatic: true,
          }),
          phase: "accepted",
          createdAt: now,
          updatedAt: now,
        });
        const record = {
          installationId: binding.installationId,
          repositoryId: binding.repositoryId,
          jobId: job.jobId,
          owner: target.owner,
          bindingId: binding._id,
          operationId,
          attempt,
          updatedAt: now,
        };
        if (demand) await ctx.db.patch("runnerDemands", demand._id, record);
        else await ctx.db.insert("runnerDemands", record);
        free--;
        scheduled = true;
        break;
      }
    }
    if (!scheduled) break;
  }
}

export async function scheduleJobScan(ctx: MutationCtx, machineId: Id<"machines">) {
  const target = await ctx.db.get("machines", machineId);
  if (!target || target.paused !== false || !(await ctx.db.query("githubApps").first())) return;
  const now = Date.now();
  const interval = 300000;
  const bindings = await ctx.db
    .query("repositoryBindings")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .take(100);
  bindings.sort((left, right) => (left.lastJobScanAt ?? 0) - (right.lastJobScanAt ?? 0));
  for (const binding of bindings) {
    if (
      !binding.enabled ||
      !binding.automatic ||
      binding.owner !== target.owner ||
      (binding.lastJobScanAt ?? 0) > now - interval
    )
      continue;
    const account = await ctx.db.get("githubAccounts", binding.accountId);
    if (account?.owner !== target.owner) continue;
    const key = `job-scan:${binding.installationId}:${binding.repositoryId}:${Math.floor(now / interval)}`;
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_owner_key", (q) => q.eq("owner", target.owner).eq("key", key))
      .unique();
    await ctx.db.patch("repositoryBindings", binding._id, { lastJobScanAt: now });
    if (existing) continue;
    await ctx.db.insert("operations", {
      owner: target.owner,
      machineId,
      key,
      commandJson: JSON.stringify({ type: "job.scan", bindingId: binding._id, automatic: true }),
      phase: "accepted",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
}
