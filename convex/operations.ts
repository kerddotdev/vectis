import { v, ConvexError } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { human, machine } from "./auth.js";
import { phase } from "./schema.js";
import { decodeCommand } from "../packages/protocol/src/index.js";

export const submit = mutation({
  args: { machineId: v.id("machines"), key: v.string(), commandJson: v.string() },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    return submitForOwner(ctx, owner, args);
  },
});
export async function submitForOwner(
  ctx: MutationCtx,
  owner: string,
  args: { machineId: Id<"machines">; key: string; commandJson: string },
) {
  const target = await ctx.db.get("machines", args.machineId);
  if (!target || target.owner !== owner) throw new ConvexError({ code: "machine_unavailable" });
  if (!args.key || args.key.length > 200 || args.commandJson.length > 65536)
    throw new ConvexError({ code: "invalid_request" });
  let commandJson: string;
  try {
    commandJson = JSON.stringify(decodeCommand(JSON.parse(args.commandJson)));
  } catch {
    throw new ConvexError({ code: "invalid_command" });
  }
  const existing = await ctx.db
    .query("operations")
    .withIndex("by_owner_key", (q) => q.eq("owner", owner).eq("key", args.key))
    .unique();
  if (existing) {
    if (existing.machineId !== args.machineId || existing.commandJson !== commandJson)
      throw new ConvexError({ code: "idempotency_conflict" });
    return existing._id;
  }
  const pending = await ctx.db
    .query("operations")
    .withIndex("by_machine_phase", (q) => q.eq("machineId", args.machineId).eq("phase", "accepted"))
    .take(100);
  if (pending.length >= 100) throw new ConvexError({ code: "queue_full" });
  const now = Date.now();
  return ctx.db.insert("operations", {
    owner,
    machineId: args.machineId,
    key: args.key,
    commandJson,
    phase: "accepted",
    createdAt: now,
    updatedAt: now,
  });
}
export const get = query({
  args: { id: v.id("operations") },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const operation = await ctx.db.get("operations", args.id);
    if (!operation || operation.owner !== owner)
      throw new ConvexError({ code: "operation_missing" });
    return operation;
  },
});
export const pending = query({
  args: {},
  handler: async (ctx) => {
    const target = await machine(ctx);
    const batches = await Promise.all(
      (["accepted", "claimed", "running"] as const).map((state) =>
        ctx.db
          .query("operations")
          .withIndex("by_machine_phase", (q) => q.eq("machineId", target._id).eq("phase", state))
          .take(100),
      ),
    );
    return batches.flat().sort((a, b) => a.createdAt - b.createdAt);
  },
});
export const acknowledge = mutation({
  args: { id: v.id("operations"), phase, resultJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const operation = await ctx.db.get("operations", args.id);
    if (!operation || operation.machineId !== target._id)
      throw new ConvexError({ code: "operation_missing" });
    if (args.resultJson && args.resultJson.length > 16384)
      throw new ConvexError({ code: "result_too_large" });
    if (operation.phase === args.phase) {
      if (operation.resultJson !== args.resultJson)
        throw new ConvexError({ code: "acknowledgement_conflict" });
      return;
    }
    const allowed: Record<typeof operation.phase, readonly string[]> = {
      accepted: ["claimed"],
      claimed: ["running", "failed", "action_required", "cancelled"],
      running: ["succeeded", "failed", "action_required", "cancelled"],
      succeeded: [],
      failed: [],
      action_required: [],
      cancelled: [],
    };
    if (!allowed[operation.phase].includes(args.phase))
      throw new ConvexError({ code: "invalid_transition" });
    await ctx.db.patch("operations", args.id, {
      phase: args.phase,
      updatedAt: Date.now(),
      ...(args.resultJson !== undefined ? { resultJson: args.resultJson } : {}),
    });
  },
});

export async function cancelForOwner(ctx: MutationCtx, owner: string, target: string) {
  const id = ctx.db.normalizeId("operations", target);
  const operation = id ? await ctx.db.get("operations", id) : null;
  if (!operation || operation.owner !== owner) throw new ConvexError({ code: "operation_missing" });
  if (["succeeded", "failed", "cancelled", "action_required"].includes(operation.phase))
    return operation._id;
  await ctx.db.patch("operations", operation._id, {
    cancelRequested: true,
    updatedAt: Date.now(),
    ...(operation.phase === "accepted" ? { phase: "cancelled" as const } : {}),
  });
  return operation._id;
}
