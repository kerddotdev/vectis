"use node";
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { human } from "./auth.js";
import { GitHubAppClient } from "../packages/github/src/app-client.js";

export const enable = action({
  args: {
    accountId: v.id("githubAccounts"),
    machineId: v.id("machines"),
    repositoryId: v.number(),
    repositoryName: v.string(),
    environmentId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"repositoryBindings">> => {
    const owner = await human(ctx);
    const verified = await ctx.runQuery(internal.repositoryBindings.authorize, {
      owner,
      accountId: args.accountId,
      machineId: args.machineId,
    });
    const { installationId } = await new GitHubAppClient(verified.app).repositoryToken({
      owner: verified.login,
      repo: args.repositoryName,
      repositoryId: args.repositoryId,
      githubUserId: verified.githubId,
    });
    return ctx.runMutation(internal.repositoryBindings.save, { ...args, owner, installationId });
  },
});
