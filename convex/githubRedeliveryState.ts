import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

export const load = internalQuery({
  args: {},
  handler: async (ctx) => {
    const app = await ctx.db.query("githubApps").first();
    if (!app) return null;
    return {
      app: { clientId: app.clientId, privateKey: app.privateKey },
      checkpoint: await ctx.db.query("githubRedeliveryCheckpoint").first(),
    };
  },
});

export const advance = internalMutation({
  args: {
    id: v.union(v.id("githubRedeliveryCheckpoint"), v.null()),
    deliveredAt: v.number(),
    scannedAt: v.number(),
  },
  handler: async (ctx, { id, ...checkpoint }) => {
    if (id) {
      await ctx.db.patch("githubRedeliveryCheckpoint", id, checkpoint);
      return;
    }
    const existing = await ctx.db.query("githubRedeliveryCheckpoint").first();
    if (existing) {
      if (existing.deliveredAt < checkpoint.deliveredAt)
        await ctx.db.patch("githubRedeliveryCheckpoint", existing._id, checkpoint);
    } else await ctx.db.insert("githubRedeliveryCheckpoint", checkpoint);
  },
});

export const claim = internalMutation({
  args: { guid: v.string() },
  handler: async (ctx, { guid }) => {
    const existing = await ctx.db
      .query("githubRedeliveryRequests")
      .withIndex("by_guid", (q) => q.eq("guid", guid))
      .unique();
    if (existing) return false;
    // Reserve before POST: a timeout may still mean GitHub accepted the request.
    await ctx.db.insert("githubRedeliveryRequests", { guid, requestedAt: Date.now() });
    return true;
  },
});
