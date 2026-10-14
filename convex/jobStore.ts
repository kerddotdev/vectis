import { jobAccess } from "../packages/github/src/access-policy.js";
import type { RepositoryAccess } from "../packages/protocol/src/repository-access.js";
import { internal } from "./_generated/api.js";
import { Schema } from "effect";
import { GitHubJob } from "../packages/github/src/job.js";
import type { Job } from "../packages/protocol/src/jobs.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

export function publicJob(job: Doc<"githubJobs">, policy?: RepositoryAccess): Job {
  const {
    jobId,
    runId,
    runAttempt,
    actorId,
    triggeringActorId,
    name,
    htmlUrl,
    workflowName,
    status,
    conclusion,
    labels,
    runnerId,
    runnerName,
    updatedAt,
  } = job;
  const access =
    job.status === "queued" || job.status === "waiting" ? jobAccess(policy, job) : undefined;
  return {
    ...(access ? { access } : {}),
    ...(runAttempt === undefined ? {} : { runAttempt }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(triggeringActorId === undefined ? {} : { triggeringActorId }),
    jobId,
    runId,
    name,
    status,
    conclusion,
    labels,
    runnerId,
    runnerName,
    updatedAt,
    ...(htmlUrl === undefined ? {} : { htmlUrl }),
    ...(workflowName === undefined ? {} : { workflowName }),
  };
}

export async function storeJob(
  ctx: MutationCtx,
  input: GitHubJob,
  installationId: number,
  repositoryId: number,
) {
  const job = Schema.decodeUnknownSync(GitHubJob)(input);
  const previous = await ctx.db
    .query("githubJobs")
    .withIndex("by_job", (q) =>
      q.eq("installationId", installationId).eq("repositoryId", repositoryId).eq("jobId", job.id),
    )
    .unique();
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
    installationId,
    repositoryId,
    jobId: job.id,
    runId: stale ? previous.runId : job.run_id,
    ...optionalActors(job, previous, stale),
    name: stale ? previous.name : job.name,
    status: stale ? previous.status : status,
    conclusion: stale ? previous.conclusion : (job.conclusion ?? previous?.conclusion ?? null),
    labels: stale ? previous.labels : [...job.labels],
    runnerId:
      (stale ? (previous.runnerId ?? job.runner_id) : (job.runner_id ?? previous?.runnerId)) ??
      null,
    runnerName:
      (stale
        ? (previous.runnerName ?? job.runner_name)
        : (job.runner_name ?? previous?.runnerName)) ?? null,
    ...(htmlUrl === undefined ? {} : { htmlUrl }),
    ...(workflowName == null ? {} : { workflowName }),
  };
  if (previous) {
    if (
      previous.runId === record.runId &&
      previous.runAttempt === record.runAttempt &&
      previous.actorId === record.actorId &&
      previous.triggeringActorId === record.triggeringActorId &&
      previous.name === record.name &&
      previous.status === record.status &&
      previous.conclusion === record.conclusion &&
      previous.runnerId === record.runnerId &&
      previous.runnerName === record.runnerName &&
      previous.htmlUrl === record.htmlUrl &&
      previous.workflowName === record.workflowName &&
      previous.labels.length === record.labels.length &&
      previous.labels.every((label, index) => label === record.labels[index])
    )
      return previous._id;
    await ctx.db.patch("githubJobs", previous._id, {
      ...record,
      actorId: record.actorId,
      triggeringActorId: record.triggeringActorId,
      runAttempt: record.runAttempt,
      updatedAt: Date.now(),
    });
  }
  const id =
    previous?._id ?? (await ctx.db.insert("githubJobs", { ...record, updatedAt: Date.now() }));
  if (record.status === "queued")
    await ctx.scheduler.runAfter(0, internal.runnerDemand.forRepository, {
      installationId,
      repositoryId,
    });
  return id;
}

function optionalActors(job: GitHubJob, previous: Doc<"githubJobs"> | null, stale: boolean) {
  const sameAttempt =
    previous?.runId === job.run_id &&
    (job.run_attempt === undefined || previous.runAttempt === job.run_attempt);
  const runAttempt = stale
    ? previous?.runAttempt
    : (job.run_attempt ?? (sameAttempt ? previous?.runAttempt : undefined));
  const actorId = stale
    ? previous?.actorId
    : (job.actor_id ?? (sameAttempt ? previous?.actorId : undefined));
  const triggeringActorId = stale
    ? previous?.triggeringActorId
    : (job.triggering_actor_id ?? (sameAttempt ? previous?.triggeringActorId : undefined));
  return {
    ...(runAttempt === undefined ? {} : { runAttempt }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(triggeringActorId === undefined ? {} : { triggeringActorId }),
  };
}
