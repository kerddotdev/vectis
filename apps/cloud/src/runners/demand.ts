import type { Env } from "../env.js";
import type { Sweep } from "../context.js";
import {
  bindingRecord,
  machineRecord,
  type BindingRow,
  type DemandRow,
  type JobRow,
  type MachineRow,
  type OperationRow,
} from "../db.js";
import { newId } from "../ids.js";
import { notifyMachine, requestDemand } from "../notify.js";
import { planDemand, type DemandCapacity, type DemandQueue } from "./plan-demand.js";

export async function demandForRepository(
  env: Env,
  installationId: number,
  repositoryId: number,
): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT machineId FROM repositoryBindings WHERE installationId = ? AND repositoryId = ? AND enabled = 1 AND automatic = 1 AND capacityMode = 'demand' LIMIT 100",
  )
    .bind(installationId, repositoryId)
    .all<{ machineId: string }>();
  await Promise.all(rows.results.map((row) => requestDemand(env, row.machineId)));
}

export const sweepDemand: Sweep = async (env) => {
  const rows =
    await env.DB.prepare(`SELECT DISTINCT b.machineId FROM githubJobs j INDEXED BY githubJobs_queued CROSS JOIN repositoryBindings b
    ON b.installationId = j.installationId AND b.repositoryId = j.repositoryId
    WHERE j.status = 'queued' AND b.enabled = 1 AND b.automatic = 1 AND b.capacityMode = 'demand' LIMIT 100`).all<{
      machineId: string;
    }>();
  await Promise.all(rows.results.map((row) => requestDemand(env, row.machineId)));
};

export async function evaluateDemand(
  env: Env,
  machineId: string,
  capacity: DemandCapacity,
): Promise<void> {
  if (capacity.runnerSlots === undefined && capacity.environmentSlots === undefined) return;
  const machineRow = await env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(machineId)
    .first<MachineRow>();
  if (!machineRow || machineRow.paused !== 0) return;
  const machine = machineRecord(machineRow);
  const rows =
    await env.DB.prepare(`SELECT b.* FROM repositoryBindings b JOIN githubAccounts a ON a.id = b.accountId AND a.owner = b.owner
    WHERE b.machineId = ? AND b.owner = ? AND b.enabled = 1 AND b.automatic = 1 AND b.capacityMode = 'demand' LIMIT 100`)
      .bind(machineId, machine.owner)
      .all<BindingRow>();
  const bindings = rows.results
    .map(bindingRecord)
    .filter((binding) =>
      machine.environments.some(
        (item) => item.id === binding.environmentId && item.state === "ready",
      ),
    );
  if (!bindings.length) return;
  const budget = Math.max(50, Math.floor(2000 / bindings.length));
  const reads = await env.DB.batch([
    ...bindings.map((binding) =>
      env.DB.prepare(
        "SELECT * FROM githubJobs WHERE installationId = ? AND repositoryId = ? AND status = 'queued' ORDER BY updatedAt LIMIT ?",
      ).bind(binding.installationId, binding.repositoryId, budget),
    ),
    ...["accepted", "claimed", "running"].map((phase) =>
      env.DB.prepare(
        `SELECT o.*, b.environmentId AS reservedEnvironmentId FROM operations o
          LEFT JOIN repositoryBindings b ON b.id = json_extract(o.commandJson, '$.bindingId') AND b.owner = o.owner AND b.machineId = o.machineId
          WHERE o.machineId = ? AND o.phase = ? ORDER BY o.createdAt LIMIT 100`,
      ).bind(machineId, phase),
    ),
    ...bindings.map((binding) =>
      env.DB.prepare(`SELECT d.*, o.id AS previousId, o.owner AS previousOwner, o.machineId AS previousMachineId, o.key AS previousKey,
      o.commandJson AS previousCommandJson, o.phase AS previousPhase, o.createdAt AS previousCreatedAt, o.updatedAt AS previousUpdatedAt,
      o.resultJson AS previousResultJson, o.cancelRequested AS previousCancelRequested
      FROM runnerDemands d LEFT JOIN operations o ON o.id = d.operationId WHERE d.installationId = ? AND d.repositoryId = ?
      AND d.jobId IN (SELECT jobId FROM githubJobs WHERE installationId = ? AND repositoryId = ? AND status = 'queued' ORDER BY updatedAt LIMIT ?)`).bind(
        binding.installationId,
        binding.repositoryId,
        binding.installationId,
        binding.repositoryId,
        budget,
      ),
    ),
  ]);
  const queues: DemandQueue[] = bindings.map((binding, index) => ({
    binding,
    environment: machine.environments.find((item) => item.id === binding.environmentId)!,
    jobs: reads[index]!.results as unknown as JobRow[],
  }));
  type Prior = DemandRow & {
    previousId: string | null;
    previousOwner: string;
    previousMachineId: string;
    previousKey: string;
    previousCommandJson: string;
    previousPhase: OperationRow["phase"];
    previousCreatedAt: number;
    previousUpdatedAt: number;
    previousResultJson: string | null;
    previousCancelRequested: OperationRow["cancelRequested"];
  };
  const demands = reads.slice(bindings.length + 3).flatMap((result) =>
    (result.results as unknown as Prior[]).map((row) => ({
      demand: row,
      ...(row.previousId
        ? {
            operation: {
              id: row.previousId,
              owner: row.previousOwner,
              machineId: row.previousMachineId,
              key: row.previousKey,
              commandJson: row.previousCommandJson,
              phase: row.previousPhase,
              createdAt: row.previousCreatedAt,
              updatedAt: row.previousUpdatedAt,
              resultJson: row.previousResultJson,
              cancelRequested: row.previousCancelRequested,
            },
          }
        : {}),
    })),
  );
  const operations = reads
    .slice(bindings.length, bindings.length + 3)
    .flatMap(
      (result) =>
        result.results as unknown as (OperationRow & { reservedEnvironmentId: string | null })[],
    );
  const now = Date.now();
  for (const claim of planDemand({
    owner: machine.owner,
    capacity,
    queues,
    demands,
    operations,
    now,
  })) {
    const { binding, job, previous, attempt, failures } = claim;
    const operationId = newId();
    const result = await env.DB.batch([
      // A machine holds at most 100 active operations (see submitOperation); when it is full,
      // neither the reservation nor the operation is written, so the job stays claimable.
      env.DB.prepare(`INSERT INTO runnerDemands (installationId, repositoryId, jobId, owner, bindingId, operationId, attempt, failures, updatedAt)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM operations WHERE machineId = ? AND phase IN ('accepted', 'claimed', 'running')) < 100
        ON CONFLICT(installationId, repositoryId, jobId) DO UPDATE SET
        owner = excluded.owner, bindingId = excluded.bindingId, operationId = excluded.operationId, attempt = excluded.attempt,
        failures = excluded.failures, updatedAt = excluded.updatedAt WHERE runnerDemands.attempt = ? AND runnerDemands.operationId = ?`).bind(
        job.installationId,
        job.repositoryId,
        job.jobId,
        machine.owner,
        binding.id,
        operationId,
        attempt,
        failures,
        now,
        machineId,
        previous?.attempt ?? 0,
        previous?.operationId ?? "",
      ),
      env.DB.prepare(`INSERT INTO operations (id, owner, machineId, key, commandJson, phase, createdAt, updatedAt)
        SELECT ?, ?, ?, ?, ?, 'accepted', ?, ? WHERE EXISTS (SELECT 1 FROM runnerDemands WHERE installationId = ? AND repositoryId = ? AND jobId = ? AND operationId = ?)`).bind(
        operationId,
        machine.owner,
        machineId,
        `automatic:${binding.installationId}:${binding.repositoryId}:${job.jobId}:${attempt}`,
        JSON.stringify({
          type: "runner.run",
          bindingId: binding.id,
          jobId: job.jobId,
          automatic: true,
        }),
        now,
        now,
        job.installationId,
        job.repositoryId,
        job.jobId,
        operationId,
      ),
    ]);
    if (result[1]!.meta.changes) await notifyMachine(env, machineId);
  }
}
