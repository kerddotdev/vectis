import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { ActivityJob } from "../../../packages/protocol/src/index.js";
import type { JobObservations } from "../../../packages/protocol/src/jobs.js";
import { RunnerProgress } from "../../../packages/protocol/src/runners.js";
import type { Store } from "./store.js";

const observationLifetime = 48 * 60 * 60 * 1000;

function runnerActivities(store: Store) {
  const snapshot = store.snapshot();
  const operations = new Map(snapshot.operations.map((operation) => [operation.id, operation]));
  const cutoff = Date.now() - observationLifetime;
  return (snapshot.activities ?? []).flatMap((activity) => {
    if (
      activity.subject.type !== "runner" ||
      activity.subject.actualJob?.status === "completed" ||
      !(Date.parse(activity.createdAt) > cutoff)
    )
      return [];
    const operation = operations.get(activity.rootOperationId);
    if (operation?.command !== "runner.run") return [];
    const progress = Schema.decodeUnknownOption(RunnerProgress)(operation.result);
    return progress._tag === "Some" && progress.value.leaseId
      ? [{ activity, leaseId: progress.value.leaseId }]
      : [];
  });
}

export function observeRunnerJobs(store: Store, observations: JobObservations) {
  const jobs = new Map(observations.map(({ leaseId, job }) => [leaseId, job]));
  for (const { activity, leaseId } of runnerActivities(store)) {
    const job = jobs.get(leaseId);
    if (!job) continue;
    const actualJob = Schema.decodeUnknownSync(ActivityJob)(job);
    if (
      activity.subject.type !== "runner" ||
      isDeepStrictEqual(activity.subject.actualJob, actualJob)
    )
      continue;
    store.updateActivity(activity.id, (base) => {
      if (base.subject.type !== "runner") return base;
      return { ...base, subject: { ...base.subject, actualJob } };
    });
  }
}

export function watchRunnerJobs(store: Store, watchLeases: (ids: readonly string[]) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingChange = false;
  const refresh = () => {
    timer = undefined;
    pendingChange = false;
    const activities = runnerActivities(store);
    watchLeases([...new Set(activities.map(({ leaseId }) => leaseId))].slice(0, 20));
    if (activities.length) {
      const expiresAt = Math.min(
        ...activities.map(({ activity }) => Date.parse(activity.createdAt) + observationLifetime),
      );
      timer = setTimeout(refresh, Math.max(1, expiresAt - Date.now()));
      timer.unref();
    }
  };
  const schedule = () => {
    if (pendingChange) return;
    if (timer) clearTimeout(timer);
    pendingChange = true;
    timer = setTimeout(refresh, 1000);
    timer.unref();
  };
  const unsubscribe = store.onChange(schedule);
  schedule();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
