import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import { workflowLabel } from "../../../../../packages/github/src/runner-labels.js";
import type { Job } from "../../../../../packages/protocol/src/jobs.js";
import type { RepositoryAccess } from "../../../../../packages/protocol/src/repository-access.js";
import type { Tone } from "@/components/status";

export const maxActorIds = 100;

export const defaultAccess: RepositoryAccess = { actors: "any", approval: "automatic" };

export function parseGitHubId(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : undefined;
}

export type AddIdResult = { ids: readonly number[] } | { error: string };

export function addActorId(ids: readonly number[], text: string): AddIdResult {
  const id = parseGitHubId(text);
  if (id === undefined) return { error: "Enter a positive whole number." };
  if (ids.includes(id)) return { error: "That ID is already on the list." };
  if (ids.length >= maxActorIds) return { error: `At most ${maxActorIds} IDs are allowed.` };
  return { ids: [...ids, id] };
}

export function sameAccess(left: RepositoryAccess, right: RepositoryAccess): boolean {
  if (left.approval !== right.approval) return false;
  if (left.actors === "any" || right.actors === "any") return left.actors === right.actors;
  const leftIds = new Set(left.actors.ids);
  return (
    leftIds.size === right.actors.ids.length && right.actors.ids.every((id) => leftIds.has(id))
  );
}

export function canSaveAccess(saved: RepositoryAccess, draft: RepositoryAccess): boolean {
  if (draft.actors !== "any" && draft.actors.ids.length === 0) return false;
  return !sameAccess(saved, draft);
}

export type JobAccess = NonNullable<Job["access"]>;

export const jobAccessPresentation = {
  approval_required: { tone: "attention", label: "Awaiting your approval", hint: undefined },
  actor_not_allowed: {
    tone: "danger",
    label: "Not allowed",
    hint: "The person who triggered this run is not on this repository's list.",
  },
  actor_unknown: {
    tone: "idle",
    label: "Actor unknown",
    hint: "Vectis could not verify who triggered this run.",
  },
} as const satisfies Record<JobAccess, { tone: Tone; label: string; hint: string | undefined }>;

export function awaitingApproval(job: Job): boolean {
  return job.access === "approval_required" && job.status !== "completed";
}

// Approval starts the runner on the environment the job asked for, not on whichever binding listed it.
export function approvalBinding(
  job: Pick<Job, "labels">,
  bindings: MachineRepositories,
  listedBy: string,
): string | undefined {
  const repositoryId = bindings.find((binding) => binding.id === listedBy)?.repositoryId;
  const labels = new Set(job.labels.map((label) => label.toLowerCase()));
  return bindings.find(
    (binding) =>
      binding.repositoryId === repositoryId &&
      labels.has(workflowLabel(binding.environmentId).toLowerCase()),
  )?.id;
}
