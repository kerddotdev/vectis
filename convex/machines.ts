import { scheduleRunnerDemand, scheduleJobScan } from "./runnerDemand.js";
import { v, ConvexError, type Infer } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, query } from "./_generated/server.js";
import { environmentSummary } from "./schema.js";
import { human, machine } from "./auth.js";
import { presence } from "./presence.js";

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
    if (existing) return existing._id;
    return ctx.db.insert("machines", { ...args, owner, createdAt: Date.now() });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await human(ctx);
    const machines = await ctx.db
      .query("machines")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(100);
    return Promise.all(
      machines.map(async (record) => {
        const current = await presence(ctx, record._id);
        return {
          ...record,
          lastSeenAt: current?.lastSeenAt,
          runnerIdle: current?.runnerIdle,
          runnerSlots: current?.runnerSlots,
        };
      }),
    );
  },
});
// Removing a machine deletes it outright, so the same Mac can pair again after the user reconnects
// it. Dependent rows are deleted in scheduled batches.
export const remove = mutation({
  args: { id: v.id("machines") },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const record = await ctx.db.get("machines", args.id);
    if (!record || record.owner !== owner) throw new ConvexError({ code: "machine_missing" });
    for (const pairing of await ctx.db
      .query("pairings")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(100))
      if (pairing.machineId === args.id) await ctx.db.delete("pairings", pairing._id);
    await ctx.db.delete("machines", args.id);
    await ctx.scheduler.runAfter(0, internal.purge.machine, { machineId: args.id });
  },
});
export const heartbeat = mutation({
  args: {
    environments: v.optional(v.array(environmentSummary)),
    paused: v.optional(v.boolean()),
    runnerIdle: v.optional(v.boolean()),
    runnerSlots: v.optional(v.number()),
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
    const changes = {
      ...(environments && !sameEnvironments(record.environments, environments)
        ? { environments }
        : {}),
      ...(args.paused === undefined || args.paused === record.paused
        ? {}
        : { paused: args.paused }),
    };
    if (Object.keys(changes).length) await ctx.db.patch("machines", record._id, changes);
    const liveness = {
      lastSeenAt: Date.now(),
      ...(args.runnerIdle === undefined ? {} : { runnerIdle: args.runnerIdle }),
      ...(args.runnerSlots === undefined ? {} : { runnerSlots: args.runnerSlots }),
    };
    const current = await presence(ctx, record._id);
    if (current) await ctx.db.patch("machinePresence", current._id, liveness);
    else await ctx.db.insert("machinePresence", { machineId: record._id, ...liveness });
    const target = { ...record, ...changes };
    await scheduleRunnerDemand(ctx, target);
    await scheduleJobScan(ctx, target);
  },
});

type Environment = Infer<typeof environmentSummary>;
function sameEnvironments(
  stored: readonly Environment[] | undefined,
  next: readonly Environment[],
) {
  return (
    stored !== undefined &&
    stored.length === next.length &&
    stored.every((item, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        item.id === other.id &&
        item.name === other.name &&
        item.os === other.os &&
        item.cpu === other.cpu &&
        item.memoryMiB === other.memoryMiB &&
        item.state === other.state &&
        item.revision === other.revision
      );
    })
  );
}
export const self = query({
  args: {},
  handler: async (ctx) => {
    const record = await machine(ctx);
    return { id: record._id, localId: record.localId };
  },
});
