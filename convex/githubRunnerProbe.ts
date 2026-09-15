"use node";
import { v } from "convex/values";
import { Schema } from "effect";
import { internalAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubAppClient } from "../packages/github/src/app-client.js";

export const prepare = internalAction({
  args: {
    owner: v.string(),
    repo: v.string(),
    repositoryId: v.number(),
    githubUserId: v.number(),
    name: v.string(),
    label: v.string(),
    os: v.union(v.literal("Linux"), v.literal("macOS"), v.literal("Windows")),
  },
  handler: async (ctx, args): Promise<{ runnerId: number; encodedConfig: string }> => {
    if (
      !/^vectis-probe-[a-z0-9-]{1,64}$/.test(args.name) ||
      !/^vectis-probe-[a-z0-9-]{1,64}$/.test(args.label)
    )
      throw new Error("Runner probes require unique Vectis probe names and labels.");
    const app = await ctx.runQuery(internal.githubAppSetup.runnerProbeCredentials, {
      githubUserId: args.githubUserId,
    });
    const client = new GitHubAppClient(app);
    const { token, path } = await client.repositoryToken(args);
    const existing = Schema.decodeUnknownSync(Schema.Struct({ total_count: Schema.Int }))(
      await client.request(token, `${path}/actions/runners`),
    );
    if (existing.total_count !== 0)
      throw new Error(
        "Probe requires an empty runner pool. Reconcile existing runners before retrying.",
      );
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        runner: Schema.Struct({ id: Schema.Int }),
        encoded_jit_config: Schema.NonEmptyString,
      }),
    )(
      await client.request(token, `${path}/actions/runners/generate-jitconfig`, {
        name: args.name,
        runner_group_id: 1,
        labels: ["self-hosted", args.os, "ARM64", args.label],
        work_folder: "_work",
      }),
    );
    return { runnerId: result.runner.id, encodedConfig: result.encoded_jit_config };
  },
});
