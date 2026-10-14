"use node";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubAppClient, GitHubApiError } from "../packages/github/src/app-client.js";
import { scanRepositoryJobs } from "../packages/github/src/job-scan.js";
import { GitHubJob } from "../packages/github/src/job.js";
import { repositoryAccess } from "./githubAccess.js";
import { pageJobLog } from "../packages/github/src/job-logs.js";
import { JobLogRequest, type JobLogs, type Job } from "../packages/protocol/src/jobs.js";

export const refresh = action({
  args: { bindingId: v.string(), jobId: v.number() },
  handler: async (ctx, args): Promise<Job> => {
    if (!Number.isSafeInteger(args.jobId) || args.jobId <= 0)
      throw new ConvexError({ code: "invalid_job_id" });
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: args.bindingId,
      preparing: false,
    });
    if (!authority.binding.enabled) throw new ConvexError({ code: "repository_access_denied" });
    const client = new GitHubAppClient(authority.app);
    const access = await client.repositoryToken({
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
      purpose: "jobs",
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({ code: "installation_changed" });
    const job = Schema.decodeUnknownSync(GitHubJob)(
      await client.request(access.token, `${access.path}/actions/jobs/${args.jobId}`),
    );
    if (job.id !== args.jobId) throw new ConvexError({ code: "job_identity_mismatch" });
    return ctx.runMutation(internal.jobs.save, {
      bindingId: args.bindingId,
      installationId: access.installationId,
      repositoryId: access.repositoryId,
      job: { ...job, labels: [...job.labels] },
    });
  },
});

export const scan = action({
  args: { bindingId: v.string() },
  handler: async (ctx, args): Promise<{ runs: number; jobs: number; complete: boolean }> => {
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: args.bindingId,
      preparing: false,
    });
    if (!authority.binding.enabled) throw new ConvexError({ code: "repository_access_denied" });
    const client = new GitHubAppClient(authority.app);
    const access = await client.repositoryToken({
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
      purpose: "jobs",
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({ code: "installation_changed" });
    const known = await ctx.runQuery(internal.jobs.pendingRuns, args);
    const result = await scanRepositoryJobs(
      (path) => client.request(access.token, access.path + path),
      async (jobs) => {
        await ctx.runMutation(internal.jobs.savePage, {
          ...args,
          installationId: access.installationId,
          repositoryId: access.repositoryId,
          jobs: jobs.map((job) => ({ ...job, labels: [...job.labels] })),
        });
      },
      known.runIds,
    );
    await ctx.runQuery(internal.jobs.pendingRuns, args);
    return { ...result, complete: result.complete && known.complete };
  },
});

export const logs = action({
  args: { bindingId: v.string(), jobId: v.number(), after: v.optional(v.number()) },
  handler: async (ctx, args): Promise<JobLogs> => {
    if (!Schema.is(JobLogRequest)(args))
      throw new ConvexError({
        code: "invalid_job_log_request",
        message: "Provide a positive job ID and a nonnegative safe integer byte cursor.",
        nextStep: "Pass the previous next cursor as after.",
      });
    const authorize = async () => {
      const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
        bindingId: args.bindingId,
        preparing: false,
      });
      if (!authority.binding.enabled)
        throw new ConvexError({
          code: "repository_access_denied",
          message: "Repository access is disabled.",
          nextStep: "Check the repository binding.",
        });
      return authority;
    };
    const authority = await authorize();
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
      purpose: "jobs",
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({
        code: "installation_changed",
        message: "The repository installation changed.",
        nextStep: "Reconnect the repository binding.",
      });
    const job = Schema.decodeUnknownSync(GitHubJob)(
      await client.request(access.token, `${access.path}/actions/jobs/${args.jobId}`),
    );
    if (job.id !== args.jobId) throw new ConvexError({ code: "job_identity_mismatch" });
    const run = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.Int, repository: Schema.Struct({ id: Schema.Int }) }),
    )(await client.request(access.token, `${access.path}/actions/runs/${job.run_id}`));
    if (run.id !== job.run_id || run.repository.id !== access.repositoryId)
      throw new ConvexError({
        code: "repository_access_denied",
        message: "The job belongs to another repository.",
        nextStep: "Use the binding for this job's repository.",
      });
    const status = job.status === "requested" || job.status === "pending" ? "queued" : job.status;
    let result: JobLogs;
    try {
      const log = await client.downloadJobLog(
        access.token,
        `${access.path}/actions/jobs/${args.jobId}/logs`,
        args.after,
      );
      result = pageJobLog(log, status, args.after);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404 && status !== "completed")
        result = { text: "", next: args.after ?? 0, status, complete: false, truncated: false };
      else
        throw new ConvexError({
          code: "job_logs_unavailable",
          message: "GitHub job logs could not be downloaded.",
          nextStep:
            "Retry when GitHub makes the log available; logs may have expired or exceeded the 64 MiB download limit.",
        });
    }
    const current = await authorize();
    if (
      current.binding.repositoryId !== access.repositoryId ||
      current.binding.installationId !== access.installationId ||
      current.binding.accountId !== authority.binding.accountId
    )
      throw new ConvexError({ code: "repository_access_denied" });
    return result;
  },
});
