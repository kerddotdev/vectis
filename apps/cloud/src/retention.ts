import type { Sweep } from "./context.js";
const day = 86400000;
const batchSize = 500;
export const sweepRetention: Sweep = async (env, now) => {
  const rules: [string, string, number, string][] = [
    ["githubRedeliveryRequests", "requestedAt", 3 * day, ""],
    ["githubDeliveries", "receivedAt", 30 * day, ""],
    ["githubJobs", "updatedAt", 90 * day, ""],
    ["operations", "updatedAt", 90 * day, " AND phase IN ('succeeded','failed','cancelled')"],
    ["runnerLeases", "updatedAt", 30 * day, " AND phase = 'released'"],
    ["runCommandReceipts", "updatedAt", 30 * day, ""],
    ["controllers", "expiresAt", 30 * day, ""],
    ["pairings", "expiresAt", 0, ""],
    ["githubLinks", "expiresAt", 0, ""],
    ["githubAppSetups", "expiresAt", 0, ""],
    ["inspections", "expiresAt", 0, ""],
    ["migrationPreviews", "expiresAt", 0, ""],
  ];
  // Full batches repeat within the run, bounded so one sweep stays small; any rest waits a day.
  let pending = rules;
  for (let round = 0; round < 20 && pending.length; round++) {
    const results = await env.DB.batch(
      pending.map(([table, column, window, filter]) =>
        env.DB.prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ?${filter} ORDER BY ${column} LIMIT ${batchSize})`,
        ).bind(now - window),
      ),
    );
    pending = pending.filter((_, index) => results[index]?.meta.changes === batchSize);
  }
};
