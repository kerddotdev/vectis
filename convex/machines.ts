import { scheduleRunnerDemand, scheduleJobScan } from "./runnerDemand.js";
import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { environmentSummary } from "./schema.js";
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
  args: {
    environments: v.optional(v.array(environmentSummary)),
    paused: v.optional(v.boolean()),
    runnerIdle: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const record = await machine(ctx);
    const environments = args.environments;
    if (
      environments &&
      (environments.length > 100 ||
        new Set(environments.map((item) => item.id)).size !== environments.length ||
        environments.some(
          (item) =>
            !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(item.id) ||
            (item.revision !== undefined && !/^[a-f0-9]{64}$/.test(item.revision)) ||
            !item.name.trim() ||
            item.name.length > 100 ||
            !Number.isSafeInteger(item.cpu) ||
            item.cpu < 1 ||
            item.cpu > 1024 ||
            !Number.isSafeInteger(item.memoryMiB) ||
            item.memoryMiB < 1 ||
            item.memoryMiB > 16777216,
        ))
    )
      throw new ConvexError({ code: "invalid_environment_inventory" });
    await ctx.db.patch("machines", record._id, {
      lastSeenAt: Date.now(),
      ...(environments ? { environments } : {}),
      ...(args.paused === undefined ? {} : { paused: args.paused }),
      ...(args.runnerIdle === undefined ? {} : { runnerIdle: args.runnerIdle }),
    });
    await scheduleRunnerDemand(ctx, record._id);
    await scheduleJobScan(ctx, record._id);
  },
});
export const self = query({
  args: {},
  handler: async (ctx) => {
    const record = await machine(ctx);
    return { id: record._id, localId: record.localId };
  },
});
