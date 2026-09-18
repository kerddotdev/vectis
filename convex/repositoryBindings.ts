import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { human, machine } from "./auth.js";

const authority = {
  owner: v.string(),
  accountId: v.id("githubAccounts"),
  machineId: v.id("machines"),
};
async function authorized(
  ctx: Pick<QueryCtx, "db">,
  input: { owner: string; accountId: Id<"githubAccounts">; machineId: Id<"machines"> },
) {
  const account = await ctx.db.get("githubAccounts", input.accountId);
  const target = await ctx.db.get("machines", input.machineId);
  if (
    !account ||
    account.owner !== input.owner ||
    !target ||
    target.owner !== input.owner ||
    target.revoked
  )
    throw new ConvexError({
      code: "repository_access_denied",
      nextStep: "Select your own connected GitHub account and an active machine.",
    });
  return account;
}
export const authorize = internalQuery({
  args: authority,
  handler: async (ctx, args) => {
    const account = await authorized(ctx, args);
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    return {
      githubId: account.githubId,
      login: account.login,
      app: { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey },
    };
  },
});
export const save = internalMutation({
  args: {
    ...authority,
    repositoryId: v.number(),
    repositoryName: v.string(),
    installationId: v.number(),
    environmentId: v.string(),
  },
  handler: async (ctx, args) => {
    await authorized(ctx, args);
    if (
      !Number.isSafeInteger(args.repositoryId) ||
      args.repositoryId <= 0 ||
      !Number.isSafeInteger(args.installationId) ||
      args.installationId <= 0 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(args.environmentId)
    )
      throw new ConvexError({ code: "invalid_repository_binding" });
    const existing = await ctx.db
      .query("repositoryBindings")
      .withIndex("by_target", (q) =>
        q
          .eq("machineId", args.machineId)
          .eq("repositoryId", args.repositoryId)
          .eq("environmentId", args.environmentId),
      )
      .unique();
    const record = { ...args, enabled: true, verifiedAt: Date.now() };
    if (existing) {
      if (existing.owner !== args.owner)
        throw new ConvexError({ code: "repository_access_denied" });
      await ctx.db.patch("repositoryBindings", existing._id, record);
      return existing._id;
    }
    const bindings = await ctx.db
      .query("repositoryBindings")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .take(100);
    if (bindings.length >= 100) throw new ConvexError({ code: "binding_limit" });
    return ctx.db.insert("repositoryBindings", record);
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await human(ctx);
    return ctx.db
      .query("repositoryBindings")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(100);
  },
});
export const forMachine = query({
  args: {},
  handler: async (ctx) => {
    const target = await machine(ctx);
    const bindings = await ctx.db
      .query("repositoryBindings")
      .withIndex("by_machine", (q) => q.eq("machineId", target._id))
      .take(100);
    const visible = [];
    for (const binding of bindings) {
      if (!binding.enabled || binding.owner !== target.owner) continue;
      const account = await ctx.db.get("githubAccounts", binding.accountId);
      if (account?.owner === target.owner)
        visible.push({
          id: binding._id,
          repositoryId: binding.repositoryId,
          repositoryName: `${account.login}/${binding.repositoryName}`,
          environmentId: binding.environmentId,
        });
    }
    return visible;
  },
});
export const disable = mutation({
  args: { id: v.id("repositoryBindings") },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const record = await ctx.db.get("repositoryBindings", args.id);
    if (!record || record.owner !== owner) throw new ConvexError({ code: "binding_missing" });
    await ctx.db.patch("repositoryBindings", args.id, { enabled: false });
  },
});
