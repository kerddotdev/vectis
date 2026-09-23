import { internal } from "./_generated/api.js";
import { Schema } from "effect";
import { GitHubJob } from "../packages/github/src/job.js";
import type { Job } from "../packages/protocol/src/jobs.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

export function publicJob(job: Doc<"githubJobs">): Job {
  const {
    jobId,
    runId,
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
  return {
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
  const order = { queued: 0, in_progress: 1, completed: 2 };
  const stale = previous !== null && order[job.status] < order[previous.status];
  const htmlUrl = stale ? (previous.htmlUrl ?? job.html_url) : (job.html_url ?? previous?.htmlUrl);
  const workflowName = stale
    ? (previous.workflowName ?? job.workflow_name)
    : (job.workflow_name ?? previous?.workflowName);
  const record = {
    installationId,
    repositoryId,
    jobId: job.id,
    runId: stale ? previous.runId : job.run_id,
    name: stale ? previous.name : job.name,
    status: stale ? previous.status : job.status,
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
    await ctx.db.patch("githubJobs", previous._id, { ...record, updatedAt: Date.now() });
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
