"use node";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubAppClient } from "../packages/github/src/app-client.js";
import { scanRepositoryJobs } from "../packages/github/src/job-scan.js";
import { GitHubJob } from "../packages/github/src/job.js";
import type { Job } from "../packages/protocol/src/jobs.js";

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
