import type { ActivityDetail, Snapshot } from "../../../../../packages/protocol/src/index.js";

export function mergeActivityDetail(snapshot: Snapshot, detail: ActivityDetail): Snapshot {
  return {
    ...snapshot,
    activities: [
      detail.activity,
      ...(snapshot.activities ?? []).filter((activity) => activity.id !== detail.activity.id),
    ],
    operations: [
      ...snapshot.operations.filter((operation) => operation.activityId !== detail.activity.id),
      ...detail.operations.toReversed(),
    ],
  };
}
