import { ConvexError, v } from "convex/values";
import { mutation, internalQuery } from "./_generated/server.js";
import { human } from "./auth.js";

export const approve = mutation({
  args: {
    requestDigest: v.string(),
    credentialDigest: v.string(),
    localId: v.string(),
    name: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    if (
      !/^[a-f0-9]{64}$/.test(args.requestDigest) ||
      !/^[a-f0-9]{64}$/.test(args.credentialDigest) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(args.localId) ||
      !args.name.trim() ||
      args.name.length > 100 ||
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + 600000
    )
      throw new ConvexError({ code: "invalid_pairing" });
    const previous = await ctx.db
      .query("pairings")
      .withIndex("by_request", (q) => q.eq("requestDigest", args.requestDigest))
      .unique();
    if (previous) {
      const machine = await ctx.db.get("machines", previous.machineId);
      const credential = await ctx.db
        .query("machineCredentials")
        .withIndex("by_machine", (q) => q.eq("machineId", previous.machineId))
        .unique();
      if (
        previous.owner !== owner ||
        previous.expiresAt !== args.expiresAt ||
        !machine ||
        machine.localId !== args.localId ||
        machine.name !== args.name ||
        credential?.digest !== args.credentialDigest
      )
        throw new ConvexError({ code: "pairing_conflict" });
      return { machineId: previous.machineId };
    }
    const recent = await ctx.db
      .query("pairings")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(100);
    if (recent.filter((item) => item.expiresAt > Date.now()).length >= 10)
      throw new ConvexError({ code: "pairing_rate_limit" });
    for (const item of recent)
      if (item.expiresAt <= Date.now()) await ctx.db.delete("pairings", item._id);
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_owner_local", (q) => q.eq("owner", owner).eq("localId", args.localId))
      .unique();
    if (existing)
      throw new ConvexError({
        code: "machine_already_linked",
        nextStep:
          "Use the existing machine connection. Replacing a connection requires a separate recovery flow.",
      });
    const machineId = await ctx.db.insert("machines", {
      owner,
      localId: args.localId,
      name: args.name,
      credentialVersion: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("machineCredentials", {
      machineId,
      digest: args.credentialDigest,
      createdAt: Date.now(),
    });
    await ctx.db.insert("pairings", {
      owner,
      requestDigest: args.requestDigest,
      machineId,
      credentialVersion: 1,
      expiresAt: args.expiresAt,
    });
    return { machineId };
  },
});

export const resolve = internalQuery({
  args: { requestDigest: v.string() },
  handler: async (ctx, args) => {
    const pairing = await ctx.db
      .query("pairings")
      .withIndex("by_request", (q) => q.eq("requestDigest", args.requestDigest))
      .unique();
    if (!pairing || pairing.expiresAt <= Date.now()) return null;
    const machine = await ctx.db.get("machines", pairing.machineId);
    if (!machine || machine.credentialVersion !== pairing.credentialVersion) return null;
    return { machineId: machine._id, localId: machine.localId };
  },
});
