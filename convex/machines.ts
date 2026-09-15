import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { human, machine } from "./auth.js";

export const enroll = mutation({
  args: { localId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(args.localId) ||
      !args.name.trim() ||
      args.name.length > 100
    )
      throw new ConvexError({ code: "invalid_machine" });
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_owner_local", (q) => q.eq("owner", owner).eq("localId", args.localId))
      .unique();
    if (existing?.revoked) throw new ConvexError({ code: "machine_revoked" });
    if (existing) return existing._id;
    return ctx.db.insert("machines", { ...args, owner, revoked: false, createdAt: Date.now() });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await human(ctx);
    return ctx.db
      .query("machines")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(100);
  },
});
export const revoke = mutation({
  args: { id: v.id("machines") },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const record = await ctx.db.get("machines", args.id);
    if (!record || record.owner !== owner) throw new ConvexError({ code: "machine_missing" });
    await ctx.db.patch("machines", args.id, { revoked: true });
  },
});
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const record = await machine(ctx);
    await ctx.db.patch("machines", record._id, { lastSeenAt: Date.now() });
  },
});
