import { Schema } from "effect";
import { GitHubJob } from "../../../../packages/github/src/job.js";
import { jobAccess } from "../../../../packages/github/src/access-policy.js";
import type { RepositoryAccess } from "../../../../packages/protocol/src/repository-access.js";
import type { Job } from "../../../../packages/protocol/src/jobs.js";
import type { JobRow, DeliveryRow } from "../db.js";
import type { Env } from "../env.js";
import { notifyMachine } from "../notify.js";
import { demandForRepository } from "../runners/demand.js";

export function mergeJob(
  previous: JobRow | null,
  job: GitHubJob & Pick<JobRow, "installationId" | "repositoryId" | "updatedAt">,
): JobRow {
  // GitHub offers waiting, requested and pending jobs to no runner until it queues them, for
  // example after an environment approval. They rank with queued, so the newest report wins.
  const status = job.status === "requested" || job.status === "pending" ? "waiting" : job.status;
  const order = { waiting: 0, queued: 0, in_progress: 1, completed: 2 };
  const stale = previous !== null && order[status] < order[previous.status];
  const htmlUrl = stale ? (previous.htmlUrl ?? job.html_url) : (job.html_url ?? previous?.htmlUrl);
  const workflowName = stale
    ? (previous.workflowName ?? job.workflow_name)
    : (job.workflow_name ?? previous?.workflowName);
  const record = {
    installationId: job.installationId,
    repositoryId: job.repositoryId,
    jobId: job.id,
    runId: stale ? previous.runId : job.run_id,
    ...optionalActors(job, previous, stale),
    name: stale ? previous.name : job.name,
    status: stale ? previous.status : status,
    conclusion: stale ? previous.conclusion : (job.conclusion ?? previous?.conclusion ?? null),
    labelsJson: stale ? previous.labelsJson : JSON.stringify(job.labels),
    runnerId:
      (stale ? (previous.runnerId ?? job.runner_id) : (job.runner_id ?? previous?.runnerId)) ??
      null,
    runnerName:
      (stale
        ? (previous.runnerName ?? job.runner_name)
        : (job.runner_name ?? previous?.runnerName)) ?? null,
    htmlUrl: htmlUrl ?? null,
    workflowName: workflowName ?? null,
  };
  const candidate = { ...record, updatedAt: previous?.updatedAt ?? 0 };
  if (
    previous &&
    Object.keys(candidate).every(
      (key) => Reflect.get(previous, key) === Reflect.get(candidate, key),
    )
  )
    return previous;
  return { ...record, updatedAt: Math.max(job.updatedAt, (previous?.updatedAt ?? 0) + 1) };
}

function optionalActors(job: GitHubJob, previous: JobRow | null, stale: boolean) {
  const sameAttempt =
    previous?.runId === job.run_id &&
    (job.run_attempt === undefined || previous.runAttempt === job.run_attempt);
  const runAttempt = stale
    ? (previous?.runAttempt ?? undefined)
    : (job.run_attempt ?? (sameAttempt ? (previous?.runAttempt ?? undefined) : undefined));
  const actorId = stale
    ? (previous?.actorId ?? undefined)
    : (job.actor_id ?? (sameAttempt ? (previous?.actorId ?? undefined) : undefined));
  const triggeringActorId = stale
    ? (previous?.triggeringActorId ?? undefined)
    : (job.triggering_actor_id ??
      (sameAttempt ? (previous?.triggeringActorId ?? undefined) : undefined));
  return {
    runAttempt: runAttempt ?? null,
    actorId: actorId ?? null,
    triggeringActorId: triggeringActorId ?? null,
  };
}

export function publicJob(row: JobRow, policy?: RepositoryAccess): Job {
  const {
    installationId: _installation,
    repositoryId: _repository,
    labelsJson,
    runAttempt,
    actorId,
    triggeringActorId,
    htmlUrl,
    workflowName,
    ...job
  } = row;
  const labels: string[] = JSON.parse(labelsJson);
  const access =
    row.status === "queued" || row.status === "waiting"
      ? jobAccess(policy, {
          runAttempt: runAttempt ?? undefined,
          actorId: actorId ?? undefined,
          triggeringActorId: triggeringActorId ?? undefined,
        })
      : undefined;
  return {
    ...job,
    labels,
    ...(runAttempt === null ? {} : { runAttempt }),
    ...(actorId === null ? {} : { actorId }),
    ...(triggeringActorId === null ? {} : { triggeringActorId }),
    ...(htmlUrl === null ? {} : { htmlUrl }),
    ...(workflowName === null ? {} : { workflowName }),
    ...(access ? { access } : {}),
  };
}

export async function jobChanged(env: Env, row: JobRow) {
  const machines = await env.DB.prepare(`SELECT DISTINCT machineId FROM repositoryBindings
    WHERE installationId = ? AND repositoryId = ? AND enabled = 1`)
    .bind(row.installationId, row.repositoryId)
    .all<{ machineId: string }>();
  await Promise.all(machines.results.map(({ machineId }) => notifyMachine(env, machineId)));
  if (row.status !== "in_progress")
    await demandForRepository(env, row.installationId, row.repositoryId);
}

export async function storeJob(
  env: Env,
  input: GitHubJob,
  installationId: number,
  repositoryId: number,
  delivery?: DeliveryRow,
) {
  const job = Schema.decodeUnknownSync(GitHubJob)(input);
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await env.DB.prepare(`SELECT * FROM githubJobs
      WHERE installationId = ? AND repositoryId = ? AND jobId = ?`)
      .bind(installationId, repositoryId, job.id)
      .first<JobRow>();
    const merged = mergeJob(previous, {
      ...job,
      installationId,
      repositoryId,
      updatedAt: Date.now(),
    });
    const row = { ...merged, installationId, repositoryId };
    const changed = merged !== previous;
    const statements: D1PreparedStatement[] = [];
    if (changed) {
      const columns = Object.keys(row);
      statements.push(
        env.DB.prepare(`INSERT INTO githubJobs (${columns.join(",")})
        SELECT ${columns.map(() => "?").join(",")} WHERE ${delivery ? "NOT EXISTS (SELECT 1 FROM githubDeliveries WHERE deliveryId = ?)" : "1"}
        ON CONFLICT (installationId, repositoryId, jobId) DO UPDATE SET
        ${columns
          .slice(3)
          .map((column) => `${column} = excluded.${column}`)
          .join(",")}
        WHERE githubJobs.updatedAt = ?`).bind(
          ...Object.values(row),
          ...(delivery ? [delivery.deliveryId] : []),
          previous?.updatedAt ?? -1,
        ),
      );
    }
    if (delivery)
      statements.push(
        env.DB.prepare(`INSERT INTO githubDeliveries
      (deliveryId,event,action,repositoryId,installationId,jobId,receivedAt)
      SELECT ?,?,?,?,?,?,? ${changed ? "WHERE changes() = 1" : ""} ON CONFLICT DO NOTHING`).bind(
          delivery.deliveryId,
          delivery.event,
          delivery.action,
          delivery.repositoryId,
          delivery.installationId,
          delivery.jobId,
          delivery.receivedAt,
        ),
      );
    if (!statements.length) return { row, changed: false, duplicate: false };
    const result = await env.DB.batch(statements);
    if (delivery && !result.at(-1)?.meta.changes) {
      const duplicate = await env.DB.prepare("SELECT 1 FROM githubDeliveries WHERE deliveryId = ?")
        .bind(delivery.deliveryId)
        .first();
      if (duplicate) return { row, changed: false, duplicate: true };
      continue;
    }
    if (changed && !result[0]?.meta.changes) continue;
    return { row, changed, duplicate: false };
  }
  throw new Error("GitHub job persistence lost too many concurrent updates.");
}
