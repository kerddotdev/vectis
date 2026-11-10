import { Schema } from "effect";
import type { Env } from "../env.js";
import type { Binding, Machine, JobRow } from "../db.js";
import { CloudError } from "../errors.js";
import type { JobObservations, JobLogs } from "../../../../packages/protocol/src/jobs.js";
import { JobLogRequest } from "../../../../packages/protocol/src/jobs.js";
import type { MachineHandler, MachineContext } from "../context.js";
import { GitHubJob } from "../../../../packages/github/src/job.js";
import { GitHubApiError } from "../../../../packages/github/src/app-client.js";
import { readRunActors, withRunActors } from "../../../../packages/github/src/run-actors.js";
import { scanRepositoryJobs } from "../../../../packages/github/src/job-scan.js";
import { pageJobLog } from "../../../../packages/github/src/job-logs.js";
import { githubErrors } from "./access.js";
import {
  githubAuthority,
  jobAuthority,
  restrictiveAuthority,
  pendingRuns,
} from "./jobs-private.js";
import { publicJob, storeJob, jobChanged } from "./job-store.js";

export const listJobs: MachineHandler<"/machine/jobs/list"> = async (c, input) => {
  const { binding } = await jobAuthority(c, input.bindingId);
  const jobs = await c.env.DB.prepare(`SELECT * FROM githubJobs INDEXED BY githubJobs_recent
    WHERE installationId = ? AND repositoryId = ? ORDER BY updatedAt DESC LIMIT 100`)
    .bind(binding.installationId, binding.repositoryId)
    .all<JobRow>();
  return jobs.results.map((row) => publicJob(row, binding.access));
};

async function save(
  c: MachineContext,
  bindingId: string,
  installationId: number,
  repositoryId: number,
  jobs: readonly GitHubJob[],
) {
  const { binding } = await jobAuthority(c, bindingId);
  if (
    binding.installationId !== installationId ||
    binding.repositoryId !== repositoryId ||
    jobs.length > 50
  )
    throw new CloudError("repository_access_changed", 403);
  let changed: JobRow | undefined;
  const rows: JobRow[] = [];
  for (const job of jobs) {
    const result = await storeJob(c.env, job, installationId, repositoryId);
    rows.push(result.row);
    if (result.changed) {
      // Preserve a demand-triggering state when another changed job follows it in this page.
      if (!changed || result.row.status !== "in_progress") changed = result.row;
    }
  }
  if (changed) await jobChanged(c.env, changed);
  return rows.map((row) => publicJob(row, binding.access));
}

export const scanJobs: MachineHandler<"/machine/jobs/scan"> = async (c, input) =>
  githubErrors(async () => {
    const { client, access } = await githubAuthority(c, input.bindingId);
    const restrictive = await restrictiveAuthority(
      c.env,
      access.installationId,
      access.repositoryId,
    );
    const known = await pendingRuns(c.env, access.installationId, access.repositoryId);
    // Each logical request can retry four times; reserve 16 fetches for repository authority.
    const result = await scanRepositoryJobs(
      (path) => client.request(access.token, access.path + path),
      async (jobs) => {
        await save(c, input.bindingId, access.installationId, access.repositoryId, jobs);
      },
      known.runIds,
      8,
      restrictive ? access.repositoryId : undefined,
    );
    return { ...result, complete: result.complete && known.complete };
  });

export const refreshJob: MachineHandler<"/machine/jobs/refresh"> = async (c, input) =>
  githubErrors(async () => {
    if (!Number.isSafeInteger(input.jobId) || input.jobId <= 0)
      throw new CloudError("invalid_job_id", 400);
    const { client, access } = await githubAuthority(c, input.bindingId);
    const job = Schema.decodeUnknownSync(GitHubJob)(
      await client
        .request(access.token, `${access.path}/actions/jobs/${input.jobId}`)
        .catch((error: unknown) => {
          if (error instanceof GitHubApiError && error.status === 404)
            throw new CloudError("job_not_found", 404, {
              message: "GitHub has no job with this ID in the repository.",
              nextStep: "Check the job ID with vectis job list, then retry.",
            });
          throw error;
        }),
    );
    if (job.id !== input.jobId) throw new CloudError("job_identity_mismatch", 502);
    const restrictive = await restrictiveAuthority(
      c.env,
      access.installationId,
      access.repositoryId,
    );
    const enriched = restrictive
      ? withRunActors(
          job,
          await readRunActors(
            (path) => client.request(access.token, access.path + path),
            access.repositoryId,
            job.run_id,
          ),
        )
      : job;
    const rows = await save(c, input.bindingId, access.installationId, access.repositoryId, [
      enriched,
    ]);
    const result = rows[0];
    if (!result) throw new Error("GitHub job persistence failed.");
    return result;
  });

export const jobLogs: MachineHandler<"/machine/jobs/logs"> = async (c, input) =>
  githubErrors(async () => {
    if (!Schema.is(JobLogRequest)(input))
      throw new CloudError("invalid_job_log_request", 400, {
        message: "Provide a positive job ID and a nonnegative safe integer byte cursor.",
        nextStep: "Pass the previous next cursor as after.",
      });
    const authority = await githubAuthority(c, input.bindingId);
    const { client, access } = authority;
    const job = Schema.decodeUnknownSync(GitHubJob)(
      await client.request(access.token, `${access.path}/actions/jobs/${input.jobId}`),
    );
    if (job.id !== input.jobId) throw new CloudError("job_identity_mismatch", 502);
    const run = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.Int, repository: Schema.Struct({ id: Schema.Int }) }),
    )(await client.request(access.token, `${access.path}/actions/runs/${job.run_id}`));
    if (run.id !== job.run_id || run.repository.id !== access.repositoryId)
      throw new CloudError("repository_access_denied", 403, {
        message: "The job belongs to another repository.",
        nextStep: "Use the binding for this job's repository.",
      });
    const status = job.status === "requested" || job.status === "pending" ? "queued" : job.status;
    let result: JobLogs;
    try {
      const log = await client.downloadJobLog(
        access.token,
        `${access.path}/actions/jobs/${input.jobId}/logs`,
        input.after,
      );
      result = pageJobLog(log, status, input.after);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404 && status !== "completed")
        result = { text: "", next: input.after ?? 0, status, complete: false, truncated: false };
      else
        throw new CloudError("job_logs_unavailable", 502, {
          message: "GitHub job logs could not be downloaded.",
          nextStep:
            "Retry when GitHub makes the log available; logs may have expired or exceeded the 64 MiB download limit.",
        });
    }
    const current = await jobAuthority(c, input.bindingId);
    if (
      current.binding.repositoryId !== access.repositoryId ||
      current.binding.installationId !== access.installationId ||
      current.binding.accountId !== authority.binding.accountId
    )
      throw new CloudError("repository_access_denied", 403);
    return result;
  });

export async function jobMarkers(
  env: Env,
  bindings: readonly Binding[],
): Promise<Record<string, number | null>> {
  if (!bindings.length) return {};
  const results = await env.DB.batch<{ updatedAt: number }>(
    bindings.map((binding) =>
      env.DB.prepare(`SELECT updatedAt FROM githubJobs INDEXED BY githubJobs_recent
    WHERE installationId = ? AND repositoryId = ? ORDER BY updatedAt DESC LIMIT 1`).bind(
        binding.installationId,
        binding.repositoryId,
      ),
    ),
  );
  return Object.fromEntries(
    bindings.map((binding, index) => [binding.id, results[index]?.results[0]?.updatedAt ?? null]),
  );
}

export async function leaseObservations(
  env: Env,
  machine: Machine,
  leaseIds: readonly string[],
): Promise<JobObservations> {
  if (leaseIds.length > 20) throw new CloudError("invalid_lease_ids", 400);
  if (!leaseIds.length) return [];
  const results = await env.DB.batch<JobRow & { leaseId: string; leaseRunnerId: number | null }>(
    [...new Set(leaseIds)].map((id) =>
      env.DB.prepare(`SELECT j.*, l.id AS leaseId, l.runnerId AS leaseRunnerId FROM runnerLeases l
    JOIN repositoryBindings b ON b.id = l.bindingId AND b.machineId = l.machineId AND b.owner = l.owner
    JOIN githubAccounts a ON a.id = b.accountId AND a.owner = l.owner
    JOIN githubJobs j ON j.installationId = b.installationId AND j.repositoryId = b.repositoryId AND j.runnerName = ?
    WHERE l.id = ? AND l.machineId = ? AND l.owner = ? LIMIT 2`).bind(
        `vectis-${id}`,
        id,
        machine.id,
        machine.owner,
      ),
    ),
  );
  return results.flatMap((result) => {
    if (result.results.length !== 1) return [];
    const row = result.results[0];
    if (!row) return [];
    const { leaseId, leaseRunnerId, ...job } = row;
    if (leaseRunnerId !== null && job.runnerId !== null && leaseRunnerId !== job.runnerId)
      return [];
    return [{ leaseId, job: publicJob(job) }];
  });
}
