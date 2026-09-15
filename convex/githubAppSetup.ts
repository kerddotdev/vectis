import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

export const create = internalMutation({
  args: { stateDigest: v.string(), ownerId: v.number(), ownerLogin: v.string() },
  handler: async (ctx, args) => {
    if (
      !/^[a-f0-9]{64}$/.test(args.stateDigest) ||
      !Number.isSafeInteger(args.ownerId) ||
      args.ownerId < 1 ||
      !/^[A-Za-z0-9-]+$/.test(args.ownerLogin)
    )
      throw new ConvexError({ code: "invalid_app_setup" });
    if (await ctx.db.query("githubApps").first())
      throw new ConvexError({ code: "app_already_configured" });
    await ctx.db.insert("githubAppSetups", {
      ...args,
      expiresAt: Date.now() + 3600000,
      consumed: false,
    });
  },
});
export const inspect = internalQuery({
  args: { stateDigest: v.string() },
  handler: async (ctx, args) => {
    const setup = await ctx.db
      .query("githubAppSetups")
      .withIndex("by_state", (q) => q.eq("stateDigest", args.stateDigest))
      .unique();
    if (!setup || setup.consumed || setup.expiresAt <= Date.now()) return null;
    return { ownerId: setup.ownerId, ownerLogin: setup.ownerLogin };
  },
});
export const save = internalMutation({
  args: {
    stateDigest: v.string(),
    appId: v.number(),
    slug: v.string(),
    ownerId: v.number(),
    clientId: v.string(),
    privateKey: v.string(),
    clientSecret: v.string(),
    webhookSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const setup = await ctx.db
      .query("githubAppSetups")
      .withIndex("by_state", (q) => q.eq("stateDigest", args.stateDigest))
      .unique();
    if (!setup || setup.consumed || setup.expiresAt <= Date.now() || setup.ownerId !== args.ownerId)
      throw new ConvexError({ code: "invalid_app_setup" });
    if (await ctx.db.query("githubApps").first())
      throw new ConvexError({ code: "app_already_configured" });
    const { stateDigest: _state, ...app } = args;
    await ctx.db.insert("githubApps", app);
    await ctx.db.patch("githubAppSetups", setup._id, { consumed: true });
  },
});

export const webhookSecret = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("githubApps").first())?.webhookSecret ?? null,
});

export const metadata = internalQuery({
  args: {},
  handler: async (ctx) => {
    const app = await ctx.db.query("githubApps").first();
    return app ? { appId: app.appId, slug: app.slug, ownerId: app.ownerId } : null;
  },
});
