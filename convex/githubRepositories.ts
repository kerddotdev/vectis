"use node";
import { isDeepStrictEqual } from "node:util";
import { repositoryAccess } from "./githubAccess.js";
import { Schema } from "effect";
import {
  RepositoryReadinessInput,
  type CloudRepositoryReadiness,
  type ReadinessCheck,
} from "../packages/protocol/src/readiness.js";
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
    repositoryOwner: v.optional(v.string()),
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
        owner: args.repositoryOwner ?? verified.login,
        githubLogin: verified.login,
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
  args: {
    accountId: v.string(),
    repositoryName: v.string(),
    repositoryOwner: v.optional(v.string()),
    environmentId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"repositoryBindings">> => {
    const verified = await ctx.runQuery(internal.repositoryBindings.authorizeMachine, {
      accountId: args.accountId,
      environmentId: args.environmentId,
    });
    const { installationId, repositoryId } = await repositoryAccess(
      new GitHubAppClient(verified.app),
      {
        owner: args.repositoryOwner ?? verified.login,
        githubLogin: verified.login,
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

export const readiness = action({
  args: {
    input: v.union(
      v.object({ repositoryName: v.string(), environmentId: v.optional(v.string()) }),
      v.object({ bindingId: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<CloudRepositoryReadiness> => {
    const input = Schema.decodeUnknownSync(RepositoryReadinessInput, { onExcessProperty: "error" })(
      args.input,
    );
    const authority = await ctx.runQuery(internal.repositoryBindings.readinessAuthority, { input });
    const checks: ReadinessCheck[] = [
      {
        id: "github.account",
        status: authority.accounts.length ? "ok" : "blocked",
        ...(authority.accounts.length
          ? {}
          : {
              code: "github_account_missing",
              nextStep: "Link a GitHub account on the Vectis account page.",
              target: { area: "connections", section: "github" } as const,
            }),
        message: authority.accounts.length
          ? "A verified GitHub account is linked."
          : "No GitHub account is linked to this machine's owner.",
      },
    ];
    const [owner, repo] = authority.repositoryName.split("/");
    if (!authority.accounts.length || !authority.app || !owner || !repo) {
      checks.push({
        id: "github.app",
        status: authority.app ? "unknown" : "blocked",
        code: authority.app ? "github_account_missing" : "github_app_unavailable",
        message: authority.app
          ? "Link a GitHub account before verifying repository access."
          : "The Vectis GitHub App is not configured.",
        nextStep: "Configure the GitHub App and link your GitHub account.",
        target: { area: "github" },
      });
      for (const id of ["github.admin", "github.approval"])
        checks.push({
          id,
          status: "unknown",
          message: "Repository policy cannot be read until GitHub App access is verified.",
          nextStep: "Resolve GitHub access, then retry readiness.",
          target: { area: "github" },
        });
    } else {
      const client = new GitHubAppClient(authority.app);
      const accounts = [...authority.accounts].sort(
        (a, b) =>
          Number(b.login.toLowerCase() === owner.toLowerCase()) -
          Number(a.login.toLowerCase() === owner.toLowerCase()),
      );
      let best: ReadinessCheck[] | undefined;
      for (const account of accounts) {
        const candidate = await client.repositoryReadiness({
          owner,
          repo,
          githubUserId: account.githubId,
          githubLogin: account.login,
          ...(authority.binding
            ? {
                repositoryId: authority.binding.repositoryId,
                installationId: authority.binding.installationId,
              }
            : {}),
        });
        if (
          !best ||
          candidate.filter((check) => check.status === "ok").length >
            best.filter((check) => check.status === "ok").length
        )
          best = candidate;
        if (candidate.every((check) => check.status === "ok")) break;
      }
      if (best) checks.push(...best);
    }
    const binding = authority.binding;
    checks.push({
      id: "repository.binding",
      status: binding?.enabled && binding.automatic ? "ok" : "attention",
      message: !binding?.enabled
        ? "The repository is not connected to this machine and environment."
        : binding.automatic
          ? "Automatic runners are enabled."
          : "The repository is connected; automatic runners are disabled.",
      ...(!binding?.enabled
        ? {
            code: "binding_missing",
            nextStep:
              "Connect the repository with the verified GitHub account and a ready environment.",
          }
        : !binding.automatic
          ? {
              code: "automatic_disabled",
              nextStep:
                "Enable automatic runners for this repository if jobs should start automatically.",
            }
          : {}),
      target: { area: "repositories" },
    });
    // Recheck credentials after external reads so revocation cannot yield a ready result.
    const current = await ctx.runQuery(internal.repositoryBindings.readinessAuthority, { input });
    if (!isDeepStrictEqual(authority, current))
      return {
        checks: checks.map((check) => ({
          ...check,
          status: "unknown" as const,
          code: "readiness_changed",
          message: "Repository connection or authorization changed during this check.",
          nextStep: "Run repository readiness again.",
        })),
        ...(current.environmentId ? { environmentId: current.environmentId } : {}),
      };
    return {
      checks,
      cacheVolumeEnabled: binding?.enabled === true && binding.cacheVolumeEnabled,
      ...(authority.environmentId ? { environmentId: authority.environmentId } : {}),
    };
  },
});
