import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { human, machine } from "./auth.js";

import { verifiedUser } from "./githubValidators.js";

export const create = internalMutation({
  args: { owner: v.string(), digest: v.string(), verifier: v.string() },
  handler: async (ctx, args) => {
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    const previous = await ctx.db
      .query("githubLinks")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(20);
    if (previous.filter((x) => x.expiresAt > Date.now()).length >= 5)
      throw new ConvexError({ code: "github_link_rate_limit" });
    for (const item of previous)
      if (item.expiresAt <= Date.now()) await ctx.db.delete("githubLinks", item._id);
    await ctx.db.insert("githubLinks", {
      ...args,
      expiresAt: Date.now() + 600000,
      phase: "pending",
    });
    return { clientId: app.clientId };
  },
});
export const claim = internalMutation({
  args: { digest: v.string() },
  handler: async (ctx, { digest }) => {
    const link = await ctx.db
      .query("githubLinks")
      .withIndex("by_digest", (q) => q.eq("digest", digest))
      .unique();
    if (!link || link.phase !== "pending" || link.expiresAt <= Date.now() || !link.verifier)
      return null;
    const app = await ctx.db.query("githubApps").first();
    if (!app) return null;
    await ctx.db.patch("githubLinks", link._id, { phase: "exchanging", verifier: undefined });
    return {
      id: link._id,
      verifier: link.verifier,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      appId: app.appId,
    };
  },
});
export const finish = internalMutation({
  args: { id: v.id("githubLinks"), user: v.optional(verifiedUser) },
  handler: async (ctx, { id, user }) => {
    const link = await ctx.db.get("githubLinks", id);
    if (!link || link.phase !== "exchanging" || link.expiresAt <= Date.now()) return;
    await ctx.db.patch("githubLinks", id, {
      phase: user ? "review" : "failed",
      ...(user ? { user } : {}),
    });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await human(ctx);
    const accounts = await ctx.db
      .query("githubAccounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    const pending = await ctx.db
      .query("githubLinks")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    return {
      accounts: accounts.map(({ _id, githubId, login, installations, verifiedAt }) => ({
        id: _id,
        githubId,
        login,
        installations,
        verifiedAt,
      })),
      pending: pending
        .filter((x) => x.expiresAt > Date.now())
        .map(({ _id, phase, user }) => ({ id: _id, phase, user })),
    };
  },
});
export const confirm = mutation({
  args: { id: v.id("githubLinks") },
  handler: async (ctx, { id }) => {
    const owner = await human(ctx);
    const link = await ctx.db.get("githubLinks", id);
    if (
      !link ||
      link.owner !== owner ||
      link.phase !== "review" ||
      !link.user ||
      link.expiresAt <= Date.now()
    )
      throw new ConvexError({ code: "github_link_unavailable" });
    const user = link.user;
    const existing = await ctx.db
      .query("githubAccounts")
      .withIndex("by_github", (q) => q.eq("githubId", user.id))
      .unique();
    if (existing && existing.owner !== owner)
      throw new ConvexError({ code: "github_account_already_linked" });
    const data = {
      owner,
      githubId: link.user.id,
      login: link.user.login,
      installations: link.user.installations,
      verifiedAt: Date.now(),
    };
    if (existing) await ctx.db.replace("githubAccounts", existing._id, data);
    else await ctx.db.insert("githubAccounts", data);
    await ctx.db.delete("githubLinks", id);
  },
});
export const discard = mutation({
  args: { id: v.id("githubLinks") },
  handler: async (ctx, { id }) => {
    const owner = await human(ctx);
    const link = await ctx.db.get("githubLinks", id);
    if (!link || link.owner !== owner) throw new ConvexError({ code: "github_link_unavailable" });
    await ctx.db.delete("githubLinks", id);
  },
});

export const forMachine = query({
  args: {},
  handler: async (ctx) => {
    const target = await machine(ctx);
    const accounts = await ctx.db
      .query("githubAccounts")
      .withIndex("by_owner", (q) => q.eq("owner", target.owner))
      .take(100);
    return accounts.map((account) => ({
      id: account._id,
      githubId: account.githubId,
      login: account.login,
    }));
  },
});
