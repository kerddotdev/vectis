import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { bindingAuthority } from "./runnerLeases.js";
import { machine } from "./auth.js";
import { runControlOutcome } from "./runCommands.js";

export const claim = internalMutation({
  args: { bindingId: v.string(), key: v.string(), requestHash: v.string() },
  handler: async (ctx, args) => {
    const { target, binding } = await bindingAuthority(ctx, args.bindingId, false);
    if (!binding.enabled) throw new ConvexError({ code: "repository_access_denied" });
    if (!args.key.trim() || args.key.length > 200 || !/^[a-f0-9]{64}$/.test(args.requestHash))
      throw new ConvexError({ code: "invalid_run_request" });
    const existing = await ctx.db
      .query("runCommandReceipts")
      .withIndex("by_machine_key", (q) => q.eq("machineId", target._id).eq("key", args.key))
      .unique();
    if (existing) {
      if (existing.bindingId !== binding._id || existing.requestHash !== args.requestHash)
        throw new ConvexError({ code: "idempotency_conflict" });
      return { fresh: false, receipt: existing };
    }
    const now = Date.now();
    const id = await ctx.db.insert("runCommandReceipts", {
      machineId: target._id,
      bindingId: binding._id,
      key: args.key,
      requestHash: args.requestHash,
      state: "submitted",
      createdAt: now,
      updatedAt: now,
    });
    const receipt = await ctx.db.get("runCommandReceipts", id);
    if (!receipt) throw new Error("Run command receipt persistence failed.");
    return { fresh: true, receipt };
  },
});
export const finish = internalMutation({
  args: { id: v.id("runCommandReceipts"), outcome: runControlOutcome },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const receipt = await ctx.db.get("runCommandReceipts", args.id);
    if (!receipt || receipt.machineId !== target._id)
      throw new ConvexError({ code: "repository_access_denied" });
    if (receipt.state !== "submitted") return;
    await ctx.db.patch("runCommandReceipts", args.id, {
      state: args.outcome.state,
      outcome: args.outcome,
      updatedAt: Date.now(),
    });
  },
});
