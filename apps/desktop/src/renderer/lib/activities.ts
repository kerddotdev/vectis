import type { Activity, Snapshot } from "../../../../../packages/protocol/src/index.js";
import { commandLabels } from "./operations";

const osLabels = { linux: "Linux", macos: "macOS", windows: "Windows" } as const;

function environmentName(activity: Activity, snapshot: Snapshot | null) {
  if (!activity.environmentId) return undefined;
  return (
    snapshot?.environments.find((item) => item.id === activity.environmentId)?.name ??
    activity.environmentId
  );
}

// What the runner actually ran, when GitHub has told us; otherwise what it was started for.
export function activityJob(activity: Activity) {
  if (activity.subject.type !== "runner") return undefined;
  return activity.subject.actualJob ?? activity.subject.requestedJob;
}

export function activityTitle(activity: Activity, snapshot: Snapshot | null) {
  if (activity.subject.type === "preparation") {
    const name = environmentName(activity, snapshot);
    return `Prepare ${osLabels[activity.subject.os]} environment${name ? `: ${name}` : ""}`;
  }
  if (activity.subject.type === "runner") {
    const job = activityJob(activity);
    if (!job?.name) return "Run a GitHub job";
    return job.workflowName ? `${job.name} · ${job.workflowName}` : `Run job ${job.name}`;
  }
  return commandLabels[activity.subject.command] ?? activity.subject.command;
}

// What the row says while it is closed: where the work happened, or what it is doing when it
// happened nowhere in particular.
export function activitySummary(activity: Activity, snapshot: Snapshot | null) {
  if (activity.subject.type === "runner") {
    const { requestedJob, actualJob } = activity.subject;
    // GitHub decides which queued job a runner receives, so the two can differ.
    if (actualJob && requestedJob && actualJob.jobId !== requestedJob.jobId)
      return `${activity.repository?.name ?? "GitHub"} · requested ${requestedJob.name ?? requestedJob.jobId}, ran ${actualJob.name ?? actualJob.jobId}`;
    if (!actualJob && !requestedJob) return "Waiting for a GitHub job";
    return activity.repository?.name ?? environmentName(activity, snapshot) ?? activity.message;
  }
  if (activity.subject.type === "preparation") return activity.message;
  return activity.repository?.name ?? environmentName(activity, snapshot) ?? activity.message;
}

export function activityMatches(activity: Activity, snapshot: Snapshot | null, query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return [
    activityTitle(activity, snapshot),
    activity.message,
    activity.repository?.name,
    environmentName(activity, snapshot),
    activityJob(activity)?.name,
    activity.subject.type === "runner" ? activity.subject.requestedJob?.name : undefined,
    activity.id,
  ].some((value) => value?.toLowerCase().includes(text));
}

// Hash history keeps the route in the URL fragment, so a notification can open an activity
// without the state provider having to reach into the router it lives above.
export function openActivity(id: string) {
  window.location.hash = `/activities?id=${encodeURIComponent(id)}`;
}
