import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
export const accept = internalMutation({
  args: {
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    repositoryId: v.optional(v.number()),
    installationId: v.optional(v.number()),
    jobId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubDeliveries")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (existing) return { duplicate: true };
    await ctx.db.insert("githubDeliveries", { ...args, receivedAt: Date.now() });
    return { duplicate: false };
  },
});
