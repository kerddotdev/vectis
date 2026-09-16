"use node";
import { repositoryAccess } from "./githubAccess.js";
import { runnerLabels } from "../packages/github/src/runner-labels.js";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import type { RunnerGrant } from "../packages/protocol/src/runners.js";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubApiError, GitHubAppClient } from "../packages/github/src/app-client.js";

const Runner = Schema.Struct({ id: Schema.Int, name: Schema.String });
const Registration = Schema.Struct({ runner: Runner, encoded_jit_config: Schema.NonEmptyString });
const Pool = Schema.Struct({ total_count: Schema.Int, runners: Schema.Array(Runner) });

export const prepare = action({
  args: { bindingId: v.string(), key: v.string() },
  handler: async (ctx, args): Promise<RunnerGrant> => {
    if (!args.key.trim() || args.key.length > 200)
      throw new ConvexError({ code: "invalid_runner_request" });
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: args.bindingId,
      preparing: true,
    });
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
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
          environmentId: lease.environmentId,
          os: lease.os,
        };
      if (lease.phase === "released") return { state: "released", id: lease._id };
      if (lease.phase === "preparing" && Date.now() - lease.updatedAt < 60000)
        return { state: "pending", id: lease._id };
      await ctx.runMutation(internal.runnerLeases.attention, { id: lease._id });
      return { state: "action_required", id: lease._id };
    }
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
      });
      return {
        state: "ready",
        id: lease._id,
        runnerId,
        encodedConfig: registration.encoded_jit_config,
        environmentId: lease.environmentId,
        os: lease.os,
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
  handler: async (ctx, args): Promise<{ state: "released"; id: string }> => {
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
      owner: authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
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
        await client.delete(access.token, path);
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      }
    }
    await ctx.runMutation(internal.runnerLeases.released, { id: lease._id });
    return { state: "released", id: lease._id };
  },
});
