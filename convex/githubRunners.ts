"use node";
import { readCacheWrite } from "../packages/github/src/cache-write.js";
import { runnerRequest } from "./runnerLeases.js";
import { githubErrors, repositoryAccess } from "./githubAccess.js";
import { runnerLabels } from "../packages/github/src/runner-labels.js";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import type { RunnerGrant, RunnerStatus } from "../packages/protocol/src/runners.js";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubApiError, GitHubAppClient } from "../packages/github/src/app-client.js";

const Runner = Schema.Struct({ id: Schema.Int, name: Schema.String });
const RunnerState = Schema.Struct({
  ...Runner.fields,
  busy: Schema.Boolean,
  status: Schema.Literals(["online", "offline"]),
});
const Registration = Schema.Struct({ runner: Runner, encoded_jit_config: Schema.NonEmptyString });
const Pool = Schema.Struct({ total_count: Schema.Int, runners: Schema.Array(Runner) });

export const prepare = action({
  args: { bindingId: v.string(), key: v.string(), ...runnerRequest },
  handler: async (ctx, args): Promise<RunnerGrant> => {
    if (!args.key.trim() || args.key.length > 200)
      throw new ConvexError({ code: "invalid_runner_request" });
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: args.bindingId,
      preparing: true,
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.automatic === undefined ? {} : { automatic: args.automatic }),
    });
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({
        code: "installation_changed",
        nextStep: "Reconnect this repository to its current GitHub App installation.",
      });
    const { fresh, lease } = await ctx.runMutation(internal.runnerLeases.claim, args);
    if (!fresh) {
      if (
        lease.phase === "ready" &&
        lease.encodedConfig &&
        lease.runnerId &&
        (lease.configExpiresAt ?? 0) > Date.now()
      )
        return {
          state: "ready",
          id: lease._id,
          runnerId: lease.runnerId,
          encodedConfig: lease.encodedConfig,
          cacheWrite: lease.cacheWrite ?? false,
          environmentId: lease.environmentId,
          os: lease.os,
          ...(lease.access
            ? {
                access: {
                  ...lease.access,
                  ...(lease.cacheRun ? { cacheRun: lease.cacheRun } : {}),
                },
              }
            : {}),
        };
      if (lease.phase === "released") return { state: "released", id: lease._id };
      if (lease.phase === "preparing" && Date.now() - lease.updatedAt < 60000)
        return { state: "pending", id: lease._id };
      await ctx.runMutation(internal.runnerLeases.attention, { id: lease._id });
      return { state: "action_required", id: lease._id };
    }
    const cache = authority.cacheJob
      ? await readCacheWrite(
          (path) => client.request(access.token, access.path + path),
          authority.binding.repositoryId,
          authority.cacheJob.runId,
          authority.cacheJob.runAttempt,
        )
      : { cacheWrite: false };
    let runnerId: number | undefined;
    try {
      const registration = Schema.decodeUnknownSync(Registration)(
        await client.request(access.token, `${access.path}/actions/runners/generate-jitconfig`, {
          name: `vectis-${lease._id}`,
          runner_group_id: 1,
          labels: runnerLabels(lease.os, lease.environmentId),
          work_folder: "_work",
        }),
      );
      runnerId = registration.runner.id;
      if (registration.runner.name !== `vectis-${lease._id}`)
        throw new Error("Runner identity mismatch.");
      await ctx.runMutation(internal.runnerLeases.ready, {
        id: lease._id,
        runnerId,
        encodedConfig: registration.encoded_jit_config,
        ...cache,
      });
      return {
        state: "ready",
        id: lease._id,
        runnerId,
        encodedConfig: registration.encoded_jit_config,
        cacheWrite: cache.cacheWrite,
        environmentId: lease.environmentId,
        os: lease.os,
        ...(lease.access
          ? { access: { ...lease.access, ...(cache.cacheRun ? { cacheRun: cache.cacheRun } : {}) } }
          : {}),
      };
    } catch {
      await ctx.runMutation(internal.runnerLeases.attention, {
        id: lease._id,
        ...(runnerId !== undefined ? { runnerId } : {}),
      });
      return { state: "action_required", id: lease._id };
    }
  },
});

export const release = action({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<{ state: "released"; id: string }> =>
    githubErrors(async () => {
      const lease = await ctx.runQuery(internal.runnerLeases.owned, args);
      if (lease.phase === "released") return { state: "released", id: lease._id };
      if (lease.phase === "preparing" && Date.now() - lease.updatedAt < 60000)
        throw new ConvexError({
          code: "runner_lease_pending",
          nextStep: "Wait for registration to finish before reconciling this lease.",
        });
      const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
        bindingId: lease.bindingId,
        preparing: false,
      });
      const client = new GitHubAppClient(authority.app);
      const access = await repositoryAccess(client, {
        owner: authority.binding.repositoryOwner ?? authority.account.login,
        repo: authority.binding.repositoryName,
        repositoryId: authority.binding.repositoryId,
        githubUserId: authority.account.githubId,
        githubLogin: authority.account.login,
        purpose: "cleanup",
      });
      const expectedName = `vectis-${lease._id}`;
      let runnerId = lease.runnerId;
      if (runnerId === undefined) {
        let searched = false;
        for (let page = 1; page <= 10; page++) {
          const pool = Schema.decodeUnknownSync(Pool)(
            await client.request(
              access.token,
              `${access.path}/actions/runners?per_page=100&page=${page}`,
            ),
          );
          const matches = pool.runners.filter((runner) => runner.name === expectedName);
          if (matches.length > 1) throw new ConvexError({ code: "runner_identity_conflict" });
          if (matches[0]) {
            runnerId = matches[0].id;
            searched = true;
            break;
          }
          if (page * 100 >= pool.total_count) {
            searched = true;
            break;
          }
        }
        if (!searched)
          throw new ConvexError({
            code: "runner_reconciliation_limit",
            nextStep: "Inspect the repository runner pool before retrying cleanup.",
          });
      }
      if (runnerId !== undefined) {
        const path = `${access.path}/actions/runners/${runnerId}`;
        try {
          const runner = Schema.decodeUnknownSync(Runner)(await client.request(access.token, path));
          if (runner.id !== runnerId || runner.name !== expectedName)
            throw new ConvexError({ code: "runner_identity_conflict" });
          try {
            await client.delete(access.token, path);
          } catch (error) {
            if (error instanceof GitHubApiError && error.status === 422)
              throw new ConvexError({
                code: "runner_busy",
                message: "GitHub still shows this runner on a job.",
                nextStep:
                  "Vectis retries cleanup automatically after GitHub releases the job, usually within 15 minutes.",
              });
            throw error;
          }
        } catch (error) {
          if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
        }
      }
      await ctx.runMutation(internal.runnerLeases.released, { id: lease._id });
      return { state: "released", id: lease._id };
    }),
});

export const status = action({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<RunnerStatus> =>
    githubErrors(async () => {
      const lease = await ctx.runQuery(internal.runnerLeases.owned, args);
      const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
        bindingId: lease.bindingId,
        preparing: false,
      });
      if (lease.phase === "released") return { missing: true };
      if (lease.runnerId === undefined)
        throw new ConvexError({ code: "runner_registration_incomplete" });
      const client = new GitHubAppClient(authority.app);
      const access = await repositoryAccess(client, {
        owner: authority.binding.repositoryOwner ?? authority.account.login,
        repo: authority.binding.repositoryName,
        repositoryId: authority.binding.repositoryId,
        githubUserId: authority.account.githubId,
        githubLogin: authority.account.login,
        purpose: "cleanup",
      });
      try {
        const runner = Schema.decodeUnknownSync(RunnerState)(
          await client.request(access.token, `${access.path}/actions/runners/${lease.runnerId}`),
        );
        if (runner.id !== lease.runnerId || runner.name !== `vectis-${lease._id}`)
          throw new ConvexError({ code: "runner_identity_conflict" });
        return { busy: runner.busy, status: runner.status };
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return { missing: true };
        throw error;
      }
    }),
});
