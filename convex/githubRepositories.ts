"use node";
import { repositoryAccess } from "./githubAccess.js";
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
    const { installationId, repositoryId } = await repositoryAccess(
      new GitHubAppClient(verified.app),
      {
        owner: verified.login,
        repo: args.repositoryName,
        githubUserId: verified.githubId,
      },
    );
    return ctx.runMutation(internal.repositoryBindings.save, {
      ...args,
      owner,
      installationId,
      repositoryId,
    });
  },
});

export const connectMachine = action({
  args: { accountId: v.string(), repositoryName: v.string(), environmentId: v.string() },
  handler: async (ctx, args): Promise<Id<"repositoryBindings">> => {
    const verified = await ctx.runQuery(internal.repositoryBindings.authorizeMachine, {
      accountId: args.accountId,
      environmentId: args.environmentId,
    });
    const { installationId, repositoryId } = await repositoryAccess(
      new GitHubAppClient(verified.app),
      {
        owner: verified.login,
        repo: args.repositoryName,
        githubUserId: verified.githubId,
      },
    );
    return ctx.runMutation(internal.repositoryBindings.saveForMachine, {
      ...args,
      accountId: verified.accountId,
      installationId,
      repositoryId,
    });
  },
});
