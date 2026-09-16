import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import { machine } from "./auth.js";

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
export const authorize = internalQuery({
  args: { bindingId: v.string(), preparing: v.boolean() },
  handler: async (ctx, args) => {
    const authority = await bindingAuthority(ctx, args.bindingId, args.preparing);
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    return {
      ...authority,
      app: { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey },
    };
  },
});
export const claim = internalMutation({
  args: { bindingId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const { target, binding, environment } = await bindingAuthority(ctx, args.bindingId, true);
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
        existing.os !== environment.os
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
      configExpiresAt: Date.now() + 15 * 60 * 1000,
      updatedAt: Date.now(),
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
