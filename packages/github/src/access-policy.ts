import type { RunnerAccess, RepositoryAccess } from "../../protocol/src/repository-access.js";

export function restrictiveAccess(access: RepositoryAccess | undefined) {
  return access !== undefined && (access.actors !== "any" || access.approval === "required");
}

export function jobAccess(
  access: RepositoryAccess | undefined,
  job: {
    actorId?: number | undefined;
    triggeringActorId?: number | undefined;
    runAttempt?: number | undefined;
  },
): "actor_unknown" | "actor_not_allowed" | "approval_required" | undefined {
  if (!restrictiveAccess(access) || !access) return undefined;
  if (job.actorId === undefined || job.triggeringActorId === undefined) return "actor_unknown";
  if (
    access.actors !== "any" &&
    (!access.actors.ids.includes(job.actorId) || !access.actors.ids.includes(job.triggeringActorId))
  )
    return "actor_not_allowed";
  if (access.approval === "required")
    return job.runAttempt === undefined ? "actor_unknown" : "approval_required";
  return undefined;
}

export function sameRunnerAccess(left: RunnerAccess | undefined, right: RunnerAccess) {
  return (
    left !== undefined &&
    left.repositoryId === right.repositoryId &&
    left.approval === right.approval &&
    left.approvedRun?.runId === right.approvedRun?.runId &&
    left.approvedRun?.runAttempt === right.approvedRun?.runAttempt &&
    (left.actors === "any"
      ? right.actors === "any"
      : right.actors !== "any" &&
        left.actors.ids.length === right.actors.ids.length &&
        left.actors.ids.every((id) => right.actors !== "any" && right.actors.ids.includes(id)))
  );
}
