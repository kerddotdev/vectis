import { Schema } from "effect";
import { GitHubJob } from "../packages/github/src/job.js";
import type { MutationCtx } from "./_generated/server.js";

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
  if (previous && order[job.status] < order[previous.status]) return previous._id;
  const record = {
    installationId,
    repositoryId,
    jobId: job.id,
    runId: job.run_id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    labels: [...job.labels],
    runnerId: job.runner_id,
    runnerName: job.runner_name,
    updatedAt: Date.now(),
  };
  if (previous) {
    await ctx.db.patch("githubJobs", previous._id, record);
    return previous._id;
  }
  return ctx.db.insert("githubJobs", record);
}
