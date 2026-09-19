import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { machine } from "./auth.js";
import type { LocalQuery } from "../packages/protocol/src/controller.js";

export async function submitInspection(
  ctx: MutationCtx,
  owner: string,
  target: string,
  key: string,
  input: LocalQuery,
) {
  const machineId = ctx.db.normalizeId("machines", target);
  const record = machineId ? await ctx.db.get("machines", machineId) : null;
  if (!record || record.owner !== owner) throw new ConvexError({ code: "machine_unavailable" });
  if (!record.lastSeenAt || Date.now() - record.lastSeenAt >= 90000)
    throw new ConvexError({ code: "machine_offline" });
  const queryJson = JSON.stringify(input);
  const existing = await ctx.db
    .query("inspections")
    .withIndex("by_owner_key", (q) => q.eq("owner", owner).eq("key", key))
    .unique();
  if (existing) {
    if (existing.machineId !== record._id || existing.queryJson !== queryJson)
      throw new ConvexError({ code: "idempotency_conflict" });
    return { queryId: existing._id };
  }
  const pending = await ctx.db
    .query("inspections")
    .withIndex("by_machine_pending", (q) =>
      q.eq("machineId", record._id).eq("pending", true).gt("expiresAt", Date.now()),
    )
    .take(20);
  if (pending.length >= 10) throw new ConvexError({ code: "query_queue_full" });
  const id = await ctx.db.insert("inspections", {
    owner,
    machineId: record._id,
    key,
    queryJson,
    expiresAt: Date.now() + 60000,
    pending: true,
  });
  await ctx.scheduler.runAfter(60000, internal.inspections.expire, { id });
  return { queryId: id };
}
export async function getInspection(ctx: QueryCtx, owner: string, target: string) {
  const id = ctx.db.normalizeId("inspections", target);
  const record = id ? await ctx.db.get("inspections", id) : null;
  if (!record || record.owner !== owner || record.expiresAt <= Date.now())
    throw new ConvexError({ code: "query_expired" });
  return { pending: record.pending, responseJson: record.responseJson ?? null };
}
export const expire = internalMutation({
  args: { id: v.id("inspections") },
  handler: async (ctx, args) => {
    await ctx.db.delete("inspections", args.id);
  },
});
export const pending = query({
  args: {},
  handler: async (ctx) => {
    const host = await machine(ctx);
    const requests = await ctx.db
      .query("inspections")
      .withIndex("by_machine_pending", (q) =>
        q.eq("machineId", host._id).eq("pending", true).gt("expiresAt", Date.now()),
      )
      .take(20);
    return requests
      .filter((request) => request.expiresAt > Date.now())
      .map(({ _id, queryJson }) => ({ id: _id, queryJson }));
  },
});
export const respond = mutation({
  args: { id: v.id("inspections"), responseJson: v.string() },
  handler: async (ctx, args) => {
    const host = await machine(ctx);
    const request = await ctx.db.get("inspections", args.id);
    if (!request || request.machineId !== host._id || request.expiresAt <= Date.now())
      throw new ConvexError({ code: "query_expired" });
    if (args.responseJson.length > 262144)
      throw new ConvexError({ code: "query_result_too_large" });
    if (!request.pending) {
      if (request.responseJson !== args.responseJson)
        throw new ConvexError({ code: "query_response_conflict" });
      return;
    }
    await ctx.db.patch("inspections", request._id, {
      pending: false,
      responseJson: args.responseJson,
    });
  },
});
