import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

export const replace = internalMutation({
  args: { owner: v.string(), machineId: v.id("machines"), digest: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.get("machines", args.machineId);
    if (!machine || machine.owner !== args.owner)
      throw new ConvexError({ code: "machine_unavailable" });
    const existing = await ctx.db
      .query("machineCredentials")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (existing && Date.now() - existing.createdAt < 5000)
      throw new ConvexError({ code: "credential_rate_limit" });
    if (existing) await ctx.db.delete("machineCredentials", existing._id);
    await ctx.db.insert("machineCredentials", {
      machineId: args.machineId,
      digest: args.digest,
      createdAt: Date.now(),
    });
    const credentialVersion = (machine.credentialVersion ?? 0) + 1;
    await ctx.db.patch("machines", machine._id, { credentialVersion });
    return credentialVersion;
  },
});
export const verify = internalQuery({
  args: { machineId: v.string(), digest: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("machines", args.machineId);
    if (!id) return null;
    const machine = await ctx.db.get("machines", id);
    if (!machine) return null;
    const credential = await ctx.db
      .query("machineCredentials")
      .withIndex("by_machine", (q) => q.eq("machineId", id))
      .unique();
    if (!credential || credential.digest !== args.digest) return null;
    return { machineId: id, credentialVersion: machine.credentialVersion ?? 0 };
  },
});
