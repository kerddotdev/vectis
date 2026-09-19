import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

// Deletions run in scheduled batches because an account can own far more rows than one mutation
// should touch. Every batch deletes what it can and reschedules itself until nothing is left.
const batch = 200;

async function deleteBinding(ctx: MutationCtx, id: Id<"repositoryBindings">) {
  const demands = await ctx.db
    .query("runnerDemands")
    .withIndex("by_binding", (q) => q.eq("bindingId", id))
    .take(batch);
  for (const demand of demands) await ctx.db.delete("runnerDemands", demand._id);
  await ctx.db.delete("repositoryBindings", id);
  return demands.length;
}

async function purgeMachine(ctx: MutationCtx, machineId: Id<"machines">) {
  let deleted = 0;
  for (const credential of await ctx.db
    .query("machineCredentials")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    await ctx.db.delete("machineCredentials", credential._id);
    deleted += 1;
  }
  for (const operation of await ctx.db
    .query("operations")
    .withIndex("by_machine_phase", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    await ctx.db.delete("operations", operation._id);
    deleted += 1;
  }
  for (const inspection of await ctx.db
    .query("inspections")
    .withIndex("by_machine_pending", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    await ctx.db.delete("inspections", inspection._id);
    deleted += 1;
  }
  for (const preview of await ctx.db
    .query("migrationPreviews")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    await ctx.db.delete("migrationPreviews", preview._id);
    deleted += 1;
  }
  for (const lease of await ctx.db
    .query("runnerLeases")
    .withIndex("by_machine_key", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    await ctx.db.delete("runnerLeases", lease._id);
    deleted += 1;
  }
  for (const binding of await ctx.db
    .query("repositoryBindings")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .take(batch)) {
    deleted += 1 + (await deleteBinding(ctx, binding._id));
  }
  return deleted;
}

export const machine = internalMutation({
  args: { machineId: v.id("machines") },
  handler: async (ctx, args) => {
    if (await purgeMachine(ctx, args.machineId))
      await ctx.scheduler.runAfter(0, internal.purge.machine, args);
  },
});

export const binding = internalMutation({
  args: { bindingId: v.id("repositoryBindings") },
  handler: async (ctx, args) => {
    const record = await ctx.db.get("repositoryBindings", args.bindingId);
    if (!record) return;
    const leases = await ctx.db
      .query("runnerLeases")
      .withIndex("by_machine_key", (q) => q.eq("machineId", record.machineId))
      .take(batch * 4);
    for (const lease of leases.filter((item) => item.bindingId === args.bindingId))
      await ctx.db.delete("runnerLeases", lease._id);
    if ((await deleteBinding(ctx, args.bindingId)) >= batch)
      await ctx.scheduler.runAfter(0, internal.purge.binding, args);
  },
});

export const owner = internalMutation({
  args: { owner: v.string() },
  handler: async (ctx, args) => {
    const machines = await ctx.db
      .query("machines")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(batch);
    for (const record of machines) {
      await ctx.db.delete("machines", record._id);
      await ctx.scheduler.runAfter(0, internal.purge.machine, { machineId: record._id });
    }
    let deleted = machines.length;
    for (const account of await ctx.db
      .query("githubAccounts")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("githubAccounts", account._id);
      deleted += 1;
    }
    for (const link of await ctx.db
      .query("githubLinks")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("githubLinks", link._id);
      deleted += 1;
    }
    for (const controller of await ctx.db
      .query("controllers")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("controllers", controller._id);
      deleted += 1;
    }
    for (const pairing of await ctx.db
      .query("pairings")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("pairings", pairing._id);
      deleted += 1;
    }
    for (const inspection of await ctx.db
      .query("inspections")
      .withIndex("by_owner_key", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("inspections", inspection._id);
      deleted += 1;
    }
    for (const operation of await ctx.db
      .query("operations")
      .withIndex("by_owner_key", (q) => q.eq("owner", args.owner))
      .take(batch)) {
      await ctx.db.delete("operations", operation._id);
      deleted += 1;
    }
    if (deleted) await ctx.scheduler.runAfter(0, internal.purge.owner, args);
  },
});
