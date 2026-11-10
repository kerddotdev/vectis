import { decodeCommand } from "../../../../packages/protocol/src/index.js";
import type { EnvironmentSummary } from "../../../../packages/protocol/src/cloud.js";
import { matchesRunnerLabels } from "../../../../packages/github/src/runner-labels.js";
import { jobAccess } from "../../../../packages/github/src/access-policy.js";
import type { Binding, DemandRow, JobRow, OperationRow } from "../db.js";

export interface DemandCapacity {
  runnerSlots?: number | undefined;
  environmentSlots?: readonly { environmentId: string; available: number }[] | undefined;
  statusAt: number;
}
export interface DemandQueue {
  binding: Binding;
  environment: EnvironmentSummary;
  jobs: readonly JobRow[];
}
export interface PlannedDemand {
  binding: Binding;
  job: JobRow;
  previous?: DemandRow;
  attempt: number;
  failures: number;
}

function resultCode(operation: OperationRow) {
  try {
    const result: unknown = JSON.parse(operation.resultJson ?? "null");
    return result && typeof result === "object" && "code" in result ? result.code : undefined;
  } catch {
    return undefined;
  }
}

export function planDemand(input: {
  owner: string;
  capacity: DemandCapacity;
  queues: readonly DemandQueue[];
  demands: readonly { demand: DemandRow; operation?: OperationRow }[];
  operations: readonly (OperationRow & { reservedEnvironmentId?: string | null })[];
  now: number;
}): PlannedDemand[] {
  const { capacity, queues, now } = input;
  const slots =
    capacity.environmentSlots === undefined
      ? undefined
      : new Map(capacity.environmentSlots.map((item) => [item.environmentId, item.available]));
  let free = capacity.runnerSlots ?? (slots ? Math.max(0, ...slots.values()) : 0);
  const bindingsById = new Map(queues.map(({ binding }) => [binding.id, binding]));
  const demandsByJob = new Map(
    input.demands.map((entry) => [
      `${entry.demand.installationId}:${entry.demand.repositoryId}:${entry.demand.jobId}`,
      entry,
    ]),
  );
  for (const operation of input.operations) {
    const command = decodeCommand(JSON.parse(operation.commandJson));
    if (
      command.type !== "runner.run" ||
      !command.automatic ||
      !["accepted", "claimed", "running"].includes(operation.phase) ||
      (operation.phase === "running" && operation.updatedAt < capacity.statusAt)
    )
      continue;
    free--;
    const environmentId =
      operation.reservedEnvironmentId ?? bindingsById.get(command.bindingId)?.environmentId;
    if (slots && environmentId) slots.set(environmentId, (slots.get(environmentId) ?? 0) - 1);
  }
  const budget = Math.max(50, Math.floor(2000 / Math.max(1, queues.length)));
  const cursors = queues.map(() => 0);
  const planned: PlannedDemand[] = [];
  const claimed = new Set<string>();
  while (free > 0) {
    let scheduled = false;
    for (const [index, queue] of queues.entries()) {
      if (free <= 0) break;
      const { binding, environment } = queue;
      if (slots && (slots.get(binding.environmentId) ?? 0) <= 0) continue;
      while (cursors[index]! < Math.min(budget, queue.jobs.length)) {
        const job = queue.jobs[cursors[index]!]!;
        cursors[index]!++;
        const key = `${job.installationId}:${job.repositoryId}:${job.jobId}`;
        if (
          claimed.has(key) ||
          jobAccess(binding.access, {
            actorId: job.actorId ?? undefined,
            triggeringActorId: job.triggeringActorId ?? undefined,
            runAttempt: job.runAttempt ?? undefined,
          }) !== undefined ||
          !matchesRunnerLabels(JSON.parse(job.labelsJson), environment.os, environment.id)
        )
          continue;
        const prior = demandsByJob.get(key);
        const demand = prior?.demand,
          previous = prior?.operation;
        let failures = demand?.failures ?? 0;
        if (demand) {
          if (demand.owner !== input.owner || demand.attempt >= 10) continue;
          if (!previous) {
            if (demand.updatedAt > now - 600000) continue;
          } else if (previous.phase === "failed" || previous.phase === "action_required") {
            if (
              previous.phase === "failed" &&
              resultCode(previous) === "cache_volume_requires_guest_sudo"
            )
              continue;
            if (previous.updatedAt > now - (previous.phase === "failed" ? 60000 : 600000)) continue;
            failures++;
          } else if (previous.phase === "cancelled") {
            if (
              !previous.cancelRequested &&
              ["machine_offline", "claim_timeout"].includes(String(resultCode(previous)))
            ) {
              if (previous.updatedAt > now - 60000) continue;
              failures++;
            } else if (job.updatedAt <= previous.createdAt) continue;
          } else if (previous.phase !== "succeeded") continue;
          if (failures >= 3) continue;
        }
        planned.push({
          binding,
          job,
          ...(demand ? { previous: demand } : {}),
          attempt: (demand?.attempt ?? 0) + 1,
          failures,
        });
        claimed.add(key);
        free--;
        if (slots) slots.set(binding.environmentId, slots.get(binding.environmentId)! - 1);
        scheduled = true;
        break;
      }
    }
    if (!scheduled) break;
  }
  return planned;
}
