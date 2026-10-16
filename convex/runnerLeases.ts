import type { Doc } from "./_generated/dataModel.js";
import {
  jobAccess,
  restrictiveAccess,
  sameRunnerAccess,
} from "../packages/github/src/access-policy.js";
import { matchesRunnerLabels } from "../packages/github/src/runner-labels.js";
import { currentScaleSet } from "./runnerScaleSets.js";
import { assertScaleSetBinding } from "./scaleSetPolicy.js";
import { scheduleRunnerDemand } from "./runnerDemand.js";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import { machine } from "./auth.js";
import { internal } from "./_generated/api.js";

export const runnerRequest = {
  jobId: v.optional(v.number()),
  automatic: v.optional(v.boolean()),
  scaleSet: v.optional(v.object({ generation: v.number() })),
};

const configLifetime = 15 * 60 * 1000;

export async function bindingAuthority(ctx: QueryCtx, bindingId: string, preparing: boolean) {
  const target = await machine(ctx);
  const id = ctx.db.normalizeId("repositoryBindings", bindingId);
  const binding = id ? await ctx.db.get("repositoryBindings", id) : null;
  if (
    !binding ||
    binding.machineId !== target._id ||
    binding.owner !== target.owner ||
    (preparing && !binding.enabled)
  )
    throw new ConvexError({ code: "repository_access_denied" });
  const account = await ctx.db.get("githubAccounts", binding.accountId);
  if (!account || account.owner !== target.owner)
    throw new ConvexError({ code: "repository_access_denied" });
  const environment = target.environments?.find((item) => item.id === binding.environmentId);
  if (preparing && environment?.state !== "ready")
    throw new ConvexError({
      code: "environment_unavailable",
      nextStep: "Prepare the environment and reconnect the machine.",
    });
  return { target, binding, account, ...(environment ? { environment } : {}) };
}
export async function runnerAdmission(
  ctx: QueryCtx,
  bindingId: string,
  request: { jobId?: number; automatic?: boolean; scaleSet?: { generation: number } },
): Promise<NonNullable<Doc<"runnerLeases">["access"]>> {
  const { binding, environment } = await bindingAuthority(ctx, bindingId, true);
  if (request.automatic && !binding.automatic)
    throw new ConvexError({ code: "automatic_disabled" });
  const policy = binding.access ?? { actors: "any" as const, approval: "automatic" as const };
  const base = { repositoryId: binding.repositoryId, ...policy };
  if (request.scaleSet) {
    assertScaleSetBinding(binding);
    if (request.jobId !== undefined) throw new ConvexError({ code: "invalid_runner_request" });
    const row = await currentScaleSet(ctx, binding, request.scaleSet.generation);
    if (
      !["active", "refreshing"].includes(row.phase) ||
      !row.sessionId ||
      row.scaleSetId === undefined
    )
      throw new ConvexError({ code: "scale_set_session_missing" });
    return base;
  }
  if (request.automatic && binding.capacityMode === "scale_set")
    throw new ConvexError({ code: "scale_set_generation_required" });
  if (request.jobId === undefined) {
    if (restrictiveAccess(policy)) throw new ConvexError({ code: "job_required" });
    return base;
  }
  if (!Number.isSafeInteger(request.jobId) || request.jobId <= 0)
    throw new ConvexError({ code: "invalid_job_id" });
  const jobId = request.jobId;
  const job = await ctx.db
    .query("githubJobs")
    .withIndex("by_job", (q) =>
      q
        .eq("installationId", binding.installationId)
        .eq("repositoryId", binding.repositoryId)
        .eq("jobId", jobId),
    )
    .unique();
  if (!job || job.status !== "queued") throw new ConvexError({ code: "job_not_queued" });
  if (!environment || !matchesRunnerLabels(job.labels, environment.os, environment.id))
    throw new ConvexError({ code: "runner_labels_mismatch" });
  const access = jobAccess(policy, job);
  if (access && (access !== "approval_required" || request.automatic))
    throw new ConvexError({ code: access });
  if (policy.approval === "required") {
    if (job.runAttempt === undefined) throw new ConvexError({ code: "actor_unknown" });
    return { ...base, approvedRun: { runId: job.runId, runAttempt: job.runAttempt } };
  }
  return base;
}
export const authorize = internalQuery({
  args: { bindingId: v.string(), preparing: v.boolean(), ...runnerRequest },
  handler: async (ctx, args) => {
    const authority = await bindingAuthority(ctx, args.bindingId, args.preparing);
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    return {
      ...authority,
      ...(args.preparing ? { access: await runnerAdmission(ctx, args.bindingId, args) } : {}),
      app: { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey },
    };
  },
});
export const claim = internalMutation({
  args: { bindingId: v.string(), key: v.string(), ...runnerRequest },
  handler: async (ctx, args) => {
    const { target, binding, environment } = await bindingAuthority(ctx, args.bindingId, true);
    const access = await runnerAdmission(ctx, args.bindingId, args);
    if (!args.key.trim() || args.key.length > 200 || !environment)
      throw new ConvexError({ code: "invalid_runner_request" });
    const existing = await ctx.db
      .query("runnerLeases")
      .withIndex("by_machine_key", (q) => q.eq("machineId", target._id).eq("key", args.key))
      .unique();
    if (existing) {
      if (
        existing.owner !== target.owner ||
        existing.bindingId !== binding._id ||
        existing.os !== environment.os ||
        // Reconciliation fences an unclaimed request with a released lease that records no request details.
        (existing.phase !== "released" &&
          (existing.jobId !== args.jobId ||
            existing.scaleSet?.generation !== args.scaleSet?.generation ||
            (existing.automatic ?? false) !== (args.automatic ?? false) ||
            !sameRunnerAccess(existing.access, access)))
      )
        throw new ConvexError({ code: "idempotency_conflict" });
      return { fresh: false, lease: existing };
    }
    let active = 0;
    for (const phase of ["preparing", "ready", "action_required"] as const)
      active += (
        await ctx.db
          .query("runnerLeases")
          .withIndex("by_machine_phase", (q) => q.eq("machineId", target._id).eq("phase", phase))
          .take(100)
      ).length;
    if (active >= 100)
      throw new ConvexError({
        code: "runner_lease_limit",
        nextStep: "Release or reconcile this machine's existing runner leases.",
      });
    const now = Date.now();
    const id = await ctx.db.insert("runnerLeases", {
      owner: target.owner,
      machineId: target._id,
      bindingId: binding._id,
      environmentId: environment.id,
      os: environment.os,
      ...(environment.revision ? { environmentRevision: environment.revision } : {}),
      key: args.key,
      ...(args.scaleSet ? { scaleSet: args.scaleSet } : {}),
      access,
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.automatic === undefined ? {} : { automatic: args.automatic }),
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
    });
    const lease = await ctx.db.get("runnerLeases", id);
    if (!lease) throw new Error("Runner lease persistence failed.");
    return { fresh: true, lease };
  },
});
export const ready = internalMutation({
  args: { id: v.id("runnerLeases"), runnerId: v.number(), encodedConfig: v.string() },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const lease = await ctx.db.get("runnerLeases", args.id);
    if (
      !lease ||
      lease.machineId !== target._id ||
      lease.owner !== target.owner ||
      lease.phase !== "preparing"
    )
      throw new ConvexError({ code: "runner_lease_conflict" });
    const authority = await bindingAuthority(ctx, lease.bindingId, true);
    const access = await runnerAdmission(ctx, lease.bindingId, {
      ...(lease.scaleSet ? { scaleSet: lease.scaleSet } : {}),
      ...(lease.jobId === undefined ? {} : { jobId: lease.jobId }),
      ...(lease.automatic === undefined ? {} : { automatic: lease.automatic }),
    });
    if (!sameRunnerAccess(lease.access, access))
      throw new ConvexError({ code: "repository_access_changed" });
    if (lease.environmentRevision !== authority.environment?.revision)
      throw new ConvexError({ code: "environment_changed" });
    if (
      !Number.isSafeInteger(args.runnerId) ||
      args.runnerId <= 0 ||
      !/^[A-Za-z0-9+/=]{1,60000}$/.test(args.encodedConfig)
    )
      throw new ConvexError({ code: "invalid_runner_configuration" });
    await ctx.db.patch("runnerLeases", args.id, {
      phase: "ready",
      runnerId: args.runnerId,
      encodedConfig: args.encodedConfig,
      configExpiresAt: Date.now() + configLifetime,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(configLifetime, internal.runnerLeases.expireConfig, {
      id: args.id,
    });
  },
});
// Runner registration configs are credentials; they are never kept past their lifetime.
export const expireConfig = internalMutation({
  args: { id: v.id("runnerLeases") },
  handler: async (ctx, args) => {
    const lease = await ctx.db.get("runnerLeases", args.id);
    if (lease?.configExpiresAt !== undefined && lease.configExpiresAt <= Date.now())
      await ctx.db.patch("runnerLeases", args.id, {
        encodedConfig: undefined,
        configExpiresAt: undefined,
      });
  },
});
export const attention = internalMutation({
  args: { id: v.id("runnerLeases"), runnerId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const lease = await ctx.db.get("runnerLeases", args.id);
    if (lease && lease.phase !== "released")
      await ctx.db.patch("runnerLeases", args.id, {
        phase: "action_required",
        encodedConfig: undefined,
        configExpiresAt: undefined,
        updatedAt: Date.now(),
        ...(args.runnerId !== undefined ? { runnerId: args.runnerId } : {}),
      });
  },
});
export const owned = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const id = ctx.db.normalizeId("runnerLeases", args.id);
    const lease = id ? await ctx.db.get("runnerLeases", id) : null;
    if (!lease || lease.machineId !== target._id || lease.owner !== target.owner)
      throw new ConvexError({ code: "runner_lease_missing" });
    return lease;
  },
});
export const released = internalMutation({
  args: { id: v.id("runnerLeases") },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const lease = await ctx.db.get("runnerLeases", args.id);
    if (!lease || lease.machineId !== target._id || lease.owner !== target.owner)
      throw new ConvexError({ code: "runner_lease_missing" });
    await ctx.db.patch("runnerLeases", args.id, {
      phase: "released",
      encodedConfig: undefined,
      configExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    if (lease.phase !== "released") await scheduleRunnerDemand(ctx, target);
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const target = await machine(ctx);
    const active = [];
    for (const phase of ["preparing", "ready", "action_required"] as const) {
      const leases = await ctx.db
        .query("runnerLeases")
        .withIndex("by_machine_phase", (q) => q.eq("machineId", target._id).eq("phase", phase))
        .take(100);
      for (const lease of leases) {
        if (lease.owner !== target.owner) continue;
        active.push({
          id: lease._id,
          bindingId: lease.bindingId,
          environmentId: lease.environmentId,
          phase: lease.phase,
          ...(lease.runnerId !== undefined ? { runnerId: lease.runnerId } : {}),
          updatedAt: lease.updatedAt,
        });
      }
    }
    return active;
  },
});

export const find = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    if (!args.key || args.key.length > 200)
      throw new ConvexError({ code: "invalid_runner_request" });
    const lease = await ctx.db
      .query("runnerLeases")
      .withIndex("by_machine_key", (q) => q.eq("machineId", target._id).eq("key", args.key))
      .unique();
    if (!lease || lease.owner !== target.owner) return null;
    return {
      id: lease._id,
      bindingId: lease.bindingId,
      environmentId: lease.environmentId,
      phase: lease.phase,
    };
  },
});

export const reconcile = mutation({
  args: { bindingId: v.string(), environmentId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const { target, binding, environment } = await bindingAuthority(ctx, args.bindingId, false);
    if (!args.key.trim() || args.key.length > 200 || binding.environmentId !== args.environmentId)
      throw new ConvexError({ code: "invalid_runner_request" });
    const lease = await ctx.db
      .query("runnerLeases")
      .withIndex("by_machine_key", (q) => q.eq("machineId", target._id).eq("key", args.key))
      .unique();
    if (lease) {
      if (
        lease.owner !== target.owner ||
        lease.bindingId !== binding._id ||
        lease.environmentId !== args.environmentId
      )
        throw new ConvexError({ code: "runner_identity_mismatch" });
      return {
        id: lease._id,
        bindingId: lease.bindingId,
        environmentId: lease.environmentId,
        phase: lease.phase,
      };
    }
    if (!environment) throw new ConvexError({ code: "environment_unavailable" });
    const now = Date.now();
    // A released lease fences a prepare action that has not reached its durable claim yet.
    const id = await ctx.db.insert("runnerLeases", {
      owner: target.owner,
      machineId: target._id,
      bindingId: binding._id,
      environmentId: environment.id,
      os: environment.os,
      ...(environment.revision ? { environmentRevision: environment.revision } : {}),
      key: args.key,
      phase: "released",
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      bindingId: binding._id,
      environmentId: environment.id,
      phase: "released" as const,
    };
  },
});
