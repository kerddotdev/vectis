import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { decodeCommand } from "../packages/protocol/src/index.js";
import { matchesRunnerLabels } from "../packages/github/src/runner-labels.js";
import { jobAccess } from "../packages/github/src/access-policy.js";
import { onlineWindow, presence } from "./presence.js";

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
  handler: async (ctx, { machineId }) => {
    const target = await ctx.db.get("machines", machineId);
    if (target) await scheduleRunnerDemand(ctx, target);
  },
});

export function automaticBindings(ctx: MutationCtx, machineId: Id<"machines">) {
  return ctx.db
    .query("repositoryBindings")
    .withIndex("by_machine_automatic", (q) =>
      q.eq("machineId", machineId).eq("enabled", true).eq("automatic", true),
    )
    .take(100);
}

const failureRetryDelay = 60000;
const actionRequiredRetryDelay = 600000;
const maxAttempts = 10;
const maxFailures = 3;
// Unclaimed runner requests get two minutes for delivery, with a ten-minute cap for online hosts.
const claimTimeoutMs = 120000;
const claimDeadlineMs = 600000;

export const expireUnclaimed = internalMutation({
  args: { operationId: v.id("operations") },
  handler: async (ctx, { operationId }) => {
    const operation = await ctx.db.get("operations", operationId);
    if (!operation || operation.phase !== "accepted") return;
    const now = Date.now();
    const current = await presence(ctx, operation.machineId);
    const online = current !== null && now - current.lastSeenAt < onlineWindow;
    const remaining = operation.createdAt + claimDeadlineMs - now;
    if (online && remaining > 0) {
      await ctx.scheduler.runAfter(
        Math.min(claimTimeoutMs, remaining),
        internal.runnerDemand.expireUnclaimed,
        {
          operationId,
        },
      );
      return;
    }
    await ctx.db.patch("operations", operationId, {
      phase: "cancelled",
      updatedAt: now,
      resultJson: JSON.stringify({
        status: "cancelled",
        code: online ? "claim_timeout" : "machine_offline",
        message: online
          ? "The machine did not claim this runner request within ten minutes."
          : "The machine went offline before it claimed this runner request.",
        resultAvailableLocally: false,
      }),
    });
  },
});

function expiredBeforeClaim(operation: Doc<"operations">) {
  if (!operation.resultJson || operation.cancelRequested) return false;
  try {
    const result: unknown = JSON.parse(operation.resultJson);
    return (
      result !== null &&
      typeof result === "object" &&
      "code" in result &&
      (result.code === "machine_offline" || result.code === "claim_timeout")
    );
  } catch {
    return false;
  }
}

// Runs on every heartbeat, so the reads an idle machine needs come first. Every return before the
// scheduling loop is free of side effects, so this order schedules exactly what any other would.
// Convex bills repeated reads within a transaction, so a heartbeat passes the bindings it already read.
export async function scheduleRunnerDemand(
  ctx: MutationCtx,
  target: Doc<"machines">,
  bindings?: Doc<"repositoryBindings">[],
) {
  const machineId = target._id;
  const liveness = await presence(ctx, machineId);
  if (!liveness || target.paused !== false || liveness.lastSeenAt < Date.now() - 60000) return;
  const environmentSlots =
    liveness.environmentSlots === undefined
      ? undefined
      : new Map(liveness.environmentSlots.map((item) => [item.environmentId, item.available]));
  const legacy = liveness.runnerSlots === undefined && environmentSlots === undefined;
  let free =
    liveness.runnerSlots ??
    (environmentSlots
      ? Math.max(0, ...environmentSlots.values())
      : liveness.runnerIdle === true
        ? 1
        : 0);
  if (free <= 0) return;
  const queues: Array<{ binding: Doc<"repositoryBindings">; jobs: Doc<"githubJobs">[] }> = [];
  for (const binding of bindings ?? (await automaticBindings(ctx, machineId))) {
    if (binding.owner !== target.owner) continue;
    const environment = target.environments?.find(
      (item) => item.id === binding.environmentId && item.state === "ready",
    );
    if (!environment) continue;
    const jobs = (
      await ctx.db
        .query("githubJobs")
        .withIndex("by_repository_queue", (q) =>
          q
            .eq("installationId", binding.installationId)
            .eq("repositoryId", binding.repositoryId)
            .eq("status", "queued"),
        )
        .take(50)
    ).filter(
      (job) =>
        jobAccess(binding.access, job) === undefined &&
        matchesRunnerLabels(job.labels, environment.os, environment.id),
    );
    if (!jobs.length) continue;
    const account = await ctx.db.get("githubAccounts", binding.accountId);
    if (account?.owner !== target.owner) continue;
    queues.push({ binding, jobs });
  }
  if (!queues.length) return;
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
        (phase !== "running" || operation.updatedAt >= liveness.lastSeenAt)
      ) {
        free--;
        if (environmentSlots) {
          const bindingId = ctx.db.normalizeId("repositoryBindings", command.bindingId);
          const binding = bindingId ? await ctx.db.get("repositoryBindings", bindingId) : null;
          if (binding?.machineId === machineId && binding.owner === target.owner)
            environmentSlots.set(
              binding.environmentId,
              (environmentSlots.get(binding.environmentId) ?? 0) - 1,
            );
        }
      }
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
  while (free > 0) {
    let scheduled = false;
    for (const { binding, jobs } of queues) {
      if (free <= 0) break;
      if (environmentSlots && (environmentSlots.get(binding.environmentId) ?? 0) <= 0) continue;
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
        let failures = demand?.failures ?? 0;
        if (demand) {
          if (demand.owner !== target.owner || demand.attempt >= maxAttempts) continue;
          const previous = await ctx.db.get("operations", demand.operationId);
          const now = Date.now();
          if (!previous) {
            if (demand.updatedAt > now - actionRequiredRetryDelay) continue;
          } else if (previous.phase === "failed" || previous.phase === "action_required") {
            const delay =
              previous.phase === "action_required" ? actionRequiredRetryDelay : failureRetryDelay;
            if (previous.updatedAt > now - delay) continue;
            failures++;
          } else if (previous.phase === "cancelled") {
            if (expiredBeforeClaim(previous)) {
              if (previous.updatedAt > now - failureRetryDelay) continue;
              failures++;
            } else if (job.updatedAt <= previous.createdAt) continue;
          } else if (previous.phase !== "succeeded") continue;
          if (failures >= maxFailures) continue;
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
          failures,
          updatedAt: now,
        };
        if (demand) await ctx.db.patch("runnerDemands", demand._id, record);
        else await ctx.db.insert("runnerDemands", record);
        await ctx.scheduler.runAfter(claimTimeoutMs, internal.runnerDemand.expireUnclaimed, {
          operationId,
        });
        free--;
        if (environmentSlots)
          environmentSlots.set(
            binding.environmentId,
            (environmentSlots.get(binding.environmentId) ?? 0) - 1,
          );
        scheduled = true;
        break;
      }
    }
    if (!scheduled) break;
  }
}

export async function scheduleJobScan(
  ctx: MutationCtx,
  target: Doc<"machines">,
  bindings: Doc<"repositoryBindings">[],
) {
  if (target.paused !== false) return;
  const now = Date.now();
  const interval = 300000;
  const due = [];
  for (const binding of bindings) {
    if (binding.owner !== target.owner) continue;
    const scan = await ctx.db
      .query("jobScans")
      .withIndex("by_binding", (q) => q.eq("bindingId", binding._id))
      .unique();
    if ((scan?.scannedAt ?? 0) <= now - interval) due.push({ binding, scan });
  }
  if (!due.length || !(await ctx.db.query("githubApps").first())) return;
  due.sort((left, right) => (left.scan?.scannedAt ?? 0) - (right.scan?.scannedAt ?? 0));
  for (const { binding, scan } of due) {
    const account = await ctx.db.get("githubAccounts", binding.accountId);
    if (account?.owner !== target.owner) continue;
    const key = `job-scan:${binding.installationId}:${binding.repositoryId}:${Math.floor(now / interval)}`;
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_owner_key", (q) => q.eq("owner", target.owner).eq("key", key))
      .unique();
    if (scan) await ctx.db.patch("jobScans", scan._id, { scannedAt: now });
    else await ctx.db.insert("jobScans", { bindingId: binding._id, scannedAt: now });
    if (existing) continue;
    await ctx.db.insert("operations", {
      owner: target.owner,
      machineId: target._id,
      key,
      commandJson: JSON.stringify({ type: "job.scan", bindingId: binding._id, automatic: true }),
      phase: "accepted",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
}
