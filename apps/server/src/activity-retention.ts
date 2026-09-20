import { isTerminal } from "./activities.js";
import type { Store } from "./store.js";

const day = 24 * 60 * 60 * 1000;

// The service keeps a month of finished work, and a recent tail whatever its size. The limits are
// arguments so a test can prove the rule without writing hundreds of rows to prove the constant.
export type RetentionLimits = { maxAgeMs: number; keep: number };
export const retentionLimits: RetentionLimits = { maxAgeMs: 30 * day, keep: 300 };

export function retainActivities(
  store: Store,
  hasTask: (operationId: string) => boolean,
  now = Date.now(),
  limits: RetentionLimits = retentionLimits,
) {
  const snapshot = store.snapshot();
  const candidates = (snapshot.activities ?? [])
    .flatMap((activity) =>
      isTerminal(activity.status) && activity.completedAt !== undefined
        ? [{ activity, completedAt: Date.parse(activity.completedAt) }]
        : [],
    )
    .sort((a, b) => b.completedAt - a.completedAt);
  for (const [index, { activity, completedAt }] of candidates.entries()) {
    const age = now - completedAt;
    if (!(age > limits.maxAgeMs || (index >= limits.keep && age > day))) continue;
    const members = store.activityMembers(activity.id);
    if (members.some((member) => hasTask(member.id) || !isTerminal(member.status))) continue;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const member of members) store.remove("operation", member.id);
      store.remove("activity", activity.id);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
  for (const operation of snapshot.operations) {
    if (
      operation.activityId === undefined &&
      isTerminal(operation.status) &&
      now - Date.parse(operation.updatedAt) > day &&
      !hasTask(operation.id)
    )
      store.remove("operation", operation.id);
  }
}
