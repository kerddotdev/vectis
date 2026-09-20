import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";

// What the privacy policy promises: nothing is kept without a reason. Job and webhook records
// outlive a single run because reconciliation and support questions need them, but not forever.
const day = 24 * 60 * 60 * 1000;
export const windows = {
  deliveries: 30 * day,
  jobs: 90 * day,
  operations: 90 * day,
  leases: 30 * day,
  controllers: 30 * day,
  requests: day,
};
const limit = 500;
const settled = ["succeeded", "failed", "cancelled"];

async function sweepTable<T extends { _id: { __tableName: string } }>(
  rows: T[],
  keep: (row: T) => boolean,
  remove: (row: T) => Promise<void>,
) {
  let deleted = 0;
  for (const row of rows)
    if (!keep(row)) {
      await remove(row);
      deleted += 1;
    }
  return deleted;
}

export async function sweepOnce(ctx: MutationCtx, now: number) {
  let deleted = 0;
  deleted += await sweepTable(
    await ctx.db
      .query("githubDeliveries")
      .withIndex("by_received", (q) => q.lt("receivedAt", now - windows.deliveries))
      .take(limit),
    () => false,
    async (row) => ctx.db.delete("githubDeliveries", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("githubJobs")
      .withIndex("by_updated", (q) => q.lt("updatedAt", now - windows.jobs))
      .take(limit),
    (row) => row.status !== "completed",
    async (row) => ctx.db.delete("githubJobs", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("operations")
      .withIndex("by_updated", (q) => q.lt("updatedAt", now - windows.operations))
      .take(limit),
    (row) => !settled.includes(row.phase),
    async (row) => ctx.db.delete("operations", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("runnerLeases")
      .withIndex("by_updated", (q) => q.lt("updatedAt", now - windows.leases))
      .take(limit),
    (row) => row.phase !== "released",
    async (row) => ctx.db.delete("runnerLeases", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("controllers")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now - windows.controllers))
      .take(limit),
    () => false,
    async (row) => ctx.db.delete("controllers", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("pairings")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now - windows.requests))
      .take(limit),
    () => false,
    async (row) => ctx.db.delete("pairings", row._id),
  );
  deleted += await sweepTable(
    await ctx.db
      .query("githubLinks")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now - windows.requests))
      .take(limit),
    () => false,
    async (row) => ctx.db.delete("githubLinks", row._id),
  );
  return deleted;
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    if ((await sweepOnce(ctx, Date.now())) >= limit)
      await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
  },
});
