import type { Activity, Snapshot } from "../../../../../packages/protocol/src/index.js";

export type OnboardingStep = {
  id: "environment" | "repository" | "job";
  state: "done" | "current" | "upcoming";
  activity?: Activity;
};

const open: ReadonlySet<Activity["status"]> = new Set(["accepted", "running", "action_required"]);

// Activities arrive newest first, so the first open one is the work the user is waiting on.
export function onboardingSteps(snapshot: Snapshot): OnboardingStep[] | undefined {
  const activities = snapshot.activities ?? [];
  const runners = activities.filter((activity) => activity.subject.type === "runner");
  const done = {
    environment: snapshot.environments.some((environment) => environment.state === "ready"),
    repository: (snapshot.repositories?.length ?? 0) > 0,
    job: runners.some(
      (activity) =>
        activity.status === "succeeded" ||
        (activity.subject.type === "runner" && activity.subject.actualJob !== undefined),
    ),
  };
  const pending = {
    environment: activities.find(
      (activity) => activity.subject.type === "preparation" && open.has(activity.status),
    ),
    repository: undefined,
    job: runners.find((activity) => open.has(activity.status)),
  };
  if (done.environment && done.repository && done.job) return undefined;
  let current = false;
  return (["environment", "repository", "job"] as const).map((id) => {
    if (done[id]) return { id, state: "done" };
    if (current) return { id, state: "upcoming" };
    current = true;
    const activity = pending[id];
    return activity ? { id, state: "current", activity } : { id, state: "current" };
  });
}
