import {
  jobAccess,
  restrictiveAccess,
  sameRunnerAccess,
} from "../../../../packages/github/src/access-policy.js";
import { matchesRunnerLabels } from "../../../../packages/github/src/runner-labels.js";
import { bindingAuthority } from "../authority.js";
import { CloudError } from "../errors.js";
import { newId } from "../ids.js";
import { notifyMachine, requestDemand } from "../notify.js";
import {
  parseJson,
  machineRecord,
  type MachineRow,
  type LeaseRow,
  type JobRow,
  type RunnerAccess,
} from "../db.js";
import type { MachineContext } from "../context.js";
import { assertScaleSetBinding, currentScaleSet } from "./scale-sets-store.js";

export type RunnerRequest = {
  bindingId: string;
  key: string;
  jobId?: number | undefined;
  automatic?: boolean | undefined;
  scaleSet?: { generation: number } | undefined;
};
export async function admission(c: MachineContext, args: Omit<RunnerRequest, "key">) {
  const machine = await c.env.DB.prepare("SELECT * FROM machines WHERE id = ? AND owner = ?")
    .bind(c.machine.id, c.machine.owner)
    .first<MachineRow>();
  if (!machine) throw new CloudError("repository_access_denied", 403);
  const authority = await bindingAuthority(c.env, machineRecord(machine), args.bindingId, true);
  const { binding, environment } = authority;
  if (args.automatic && !binding.automatic) throw new CloudError("automatic_disabled", 409);
  const policy = binding.access ?? { actors: "any" as const, approval: "automatic" as const };
  let base: RunnerAccess = { repositoryId: binding.repositoryId, ...policy };
  if (args.scaleSet) {
    assertScaleSetBinding(binding);
    if (args.jobId !== undefined) throw new CloudError("invalid_runner_request", 400);
    const row = await currentScaleSet(c.env, binding, args.scaleSet.generation);
    if (!["active", "refreshing"].includes(row.phase) || !row.sessionId || row.scaleSetId === null)
      throw new CloudError("scale_set_session_missing", 409);
    return { ...authority, access: base, cacheJob: null };
  }
  if (args.automatic && binding.capacityMode === "scale_set")
    throw new CloudError("scale_set_generation_required", 409);
  if (args.jobId === undefined) {
    if (restrictiveAccess(policy)) throw new CloudError("job_required", 409);
    return { ...authority, access: base, cacheJob: null };
  }
  if (!Number.isSafeInteger(args.jobId) || args.jobId <= 0)
    throw new CloudError("invalid_job_id", 400);
  const job = await c.env.DB.prepare(
    "SELECT * FROM githubJobs WHERE installationId = ? AND repositoryId = ? AND jobId = ?",
  )
    .bind(binding.installationId, binding.repositoryId, args.jobId)
    .first<JobRow>();
  if (!job || job.status !== "queued") throw new CloudError("job_not_queued", 409);
  if (
    !environment ||
    !matchesRunnerLabels(JSON.parse(job.labelsJson), environment.os, environment.id)
  )
    throw new CloudError("runner_labels_mismatch", 409);
  const denied = jobAccess(policy, {
    actorId: job.actorId ?? undefined,
    triggeringActorId: job.triggeringActorId ?? undefined,
    runAttempt: job.runAttempt ?? undefined,
  });
  if (denied && (denied !== "approval_required" || args.automatic))
    throw new CloudError(denied, 403);
  if (policy.approval === "required") {
    if (job.runAttempt === null) throw new CloudError("actor_unknown", 403);
    base = { ...base, approvedRun: { runId: job.runId, runAttempt: job.runAttempt } };
  }
  return {
    ...authority,
    access: base,
    cacheJob: binding.cacheVolume?.enabled
      ? { runId: job.runId, runAttempt: job.runAttempt ?? undefined }
      : null,
  };
}
export function leaseRecord(row: LeaseRow) {
  return {
    ...row,
    runnerId: row.runnerId ?? undefined,
    access: parseJson<RunnerAccess>(row.accessJson),
    cacheRun: parseJson<{ runId: number; runAttempt: number }>(row.cacheRunJson),
    cacheWrite: row.cacheWrite === 1,
  };
}
export async function owned(c: MachineContext, id: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM runnerLeases WHERE id = ? AND machineId = ? AND owner = ?",
  )
    .bind(id, c.machine.id, c.machine.owner)
    .first<LeaseRow>();
  if (!row) throw new CloudError("runner_lease_missing", 404);
  return leaseRecord(row);
}
export async function claim(c: MachineContext, args: RunnerRequest) {
  const { binding, environment, access } = await admission(c, args);
  if (!environment || !args.key.trim() || args.key.length > 200)
    throw new CloudError("invalid_runner_request", 400);
  const id = newId();
  const now = Date.now();
  const result =
    await c.env.DB.prepare(`INSERT INTO runnerLeases (id, owner, machineId, bindingId, environmentId, os, environmentRevision, key, phase, createdAt, updatedAt, accessJson, jobId, automatic, scaleSetGeneration)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM runnerLeases WHERE machineId = ? AND phase IN ('preparing','ready','action_required')) < 100 ON CONFLICT (machineId, key) DO NOTHING`)
      .bind(
        id,
        c.machine.owner,
        c.machine.id,
        binding.id,
        environment.id,
        environment.os,
        environment.revision ?? null,
        args.key,
        now,
        now,
        JSON.stringify(access),
        args.jobId ?? null,
        args.automatic ? 1 : 0,
        args.scaleSet?.generation ?? null,
        c.machine.id,
      )
      .run();
  const row = await c.env.DB.prepare("SELECT * FROM runnerLeases WHERE machineId = ? AND key = ?")
    .bind(c.machine.id, args.key)
    .first<LeaseRow>();
  if (!row)
    throw new CloudError("runner_lease_limit", 409, {
      nextStep: "Release or reconcile this machine's existing runner leases.",
    });
  if (
    row.owner !== c.machine.owner ||
    row.bindingId !== binding.id ||
    row.os !== environment.os ||
    (row.phase !== "released" &&
      (row.jobId !== (args.jobId ?? null) ||
        row.scaleSetGeneration !== (args.scaleSet?.generation ?? null) ||
        row.automatic !== (args.automatic ? 1 : 0) ||
        !sameRunnerAccess(parseJson<RunnerAccess>(row.accessJson), access)))
  )
    throw new CloudError("idempotency_conflict", 409);
  if (result.meta.changes) await notifyMachine(c.env, c.machine.id);
  return { fresh: row.id === id, lease: leaseRecord(row) };
}
export async function attention(c: MachineContext, id: string, runnerId?: number) {
  const result = await c.env.DB.prepare(
    "UPDATE runnerLeases SET phase = 'action_required', encodedConfig = NULL, configExpiresAt = NULL, runnerId = COALESCE(?, runnerId), updatedAt = ? WHERE id = ? AND machineId = ? AND phase != 'released' AND (phase != 'action_required' OR (? IS NOT NULL AND runnerId IS NOT ?))",
  )
    .bind(runnerId ?? null, Date.now(), id, c.machine.id, runnerId ?? null, runnerId ?? null)
    .run();
  if (result.meta.changes) await notifyMachine(c.env, c.machine.id);
}
export async function ready(
  c: MachineContext,
  input: {
    id: string;
    runnerId: number;
    encodedConfig: string;
    cacheWrite?: boolean;
    cacheWriteReason?: string;
    cacheRun?: { runId: number; runAttempt: number };
  },
) {
  const lease = await owned(c, input.id);
  if (lease.phase !== "preparing") throw new CloudError("runner_lease_conflict", 409);
  const authority = await admission(c, {
    bindingId: lease.bindingId,
    jobId: lease.jobId ?? undefined,
    automatic: lease.automatic === 1,
    scaleSet:
      lease.scaleSetGeneration === null ? undefined : { generation: lease.scaleSetGeneration },
  });
  if (!sameRunnerAccess(lease.access, authority.access))
    throw new CloudError("repository_access_changed", 409);
  if (lease.environmentRevision !== (authority.environment?.revision ?? null))
    throw new CloudError("environment_changed", 409);
  if (
    !Number.isSafeInteger(input.runnerId) ||
    input.runnerId <= 0 ||
    !/^[A-Za-z0-9+/=]{1,60000}$/.test(input.encodedConfig)
  )
    throw new CloudError("invalid_runner_configuration", 502);
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE runnerLeases SET phase = 'ready', runnerId = ?, encodedConfig = ?, cacheWrite = ?, cacheWriteReason = ?, cacheRunJson = ?, configExpiresAt = ?, updatedAt = ? WHERE id = ? AND phase = 'preparing'
    AND EXISTS (SELECT 1 FROM repositoryBindings b JOIN githubAccounts a ON a.id = b.accountId JOIN machines m ON m.id = b.machineId
      WHERE b.id = runnerLeases.bindingId AND b.owner = ? AND a.owner = b.owner AND m.owner = b.owner AND b.enabled = 1 AND b.installationId = ? AND b.repositoryId = ? AND b.environmentId = ? AND b.accessJson IS ? AND b.automatic = ? AND b.capacityMode = ? AND m.environmentsJson = ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM runnerScaleSets s WHERE s.bindingId = runnerLeases.bindingId AND s.machineId = runnerLeases.machineId AND s.generation = ? AND s.phase IN ('active','refreshing') AND s.sessionId IS NOT NULL))`,
  )
    .bind(
      input.runnerId,
      input.encodedConfig,
      input.cacheWrite && input.cacheRun ? 1 : 0,
      input.cacheWriteReason?.slice(0, 256) ?? null,
      input.cacheRun ? JSON.stringify(input.cacheRun) : null,
      now + 900000,
      now,
      input.id,
      c.machine.owner,
      authority.binding.installationId,
      authority.binding.repositoryId,
      authority.binding.environmentId,
      authority.binding.access ? JSON.stringify(authority.binding.access) : null,
      authority.binding.automatic ? 1 : 0,
      authority.binding.capacityMode,
      JSON.stringify(authority.machine.environments),
      lease.scaleSetGeneration,
      lease.scaleSetGeneration,
    )
    .run();
  if (!result.meta.changes) throw new CloudError("runner_lease_conflict", 409);
  await notifyMachine(c.env, c.machine.id);
}
export async function released(c: MachineContext, id: string) {
  const result = await c.env.DB.prepare(
    "UPDATE runnerLeases SET phase = 'released', encodedConfig = NULL, configExpiresAt = NULL, updatedAt = ? WHERE id = ? AND machineId = ? AND phase != 'released'",
  )
    .bind(Date.now(), id, c.machine.id)
    .run();
  if (result.meta.changes) {
    await notifyMachine(c.env, c.machine.id);
    await requestDemand(c.env, c.machine.id);
  }
}
