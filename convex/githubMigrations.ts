"use node";
import { repositoryAccess } from "./githubAccess.js";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { GitHubAppClient } from "../packages/github/src/app-client.js";
import { readRepositoryWorkflows } from "../packages/github/src/workflow-repository.js";
import { publishMigration } from "../packages/github/src/migration-pr.js";
import { previewMigration } from "../packages/migration/src/index.js";
import {
  RepositoryMigration,
  type MigrationAnalysis,
  type MigrationPublication,
} from "../packages/protocol/src/migrations.js";

export const analyze = action({
  args: { bindingId: v.string() },
  handler: async (ctx, args): Promise<MigrationAnalysis> => {
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      ...args,
      preparing: true,
    });
    if (!authority.environment) throw new ConvexError({ code: "environment_unavailable" });
    const environment = authority.environment;
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      purpose: "migration-read",
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({ code: "installation_changed" });
    const source = await readRepositoryWorkflows(
      (path) => client.request(access.token, access.path + path),
      access.repositoryId,
    );
    const labels =
      environment.os === "linux"
        ? ["ubuntu-24.04-arm", "ubuntu-24.04", "ubuntu-latest"]
        : environment.os === "windows"
          ? ["windows-11-arm", "windows-latest", "windows-2025", "windows-2022"]
          : ["macos-26", "macos-latest"];
    const targets = labels.map((from) => ({ from, to: `vectis-${environment.id}` }));
    const report = {
      baseBranch: source.baseBranch,
      baseCommit: source.baseCommit,
      files: source.files.map((file) => {
        const preview = previewMigration(file.source, targets);
        return {
          path: file.path,
          mode: file.mode,
          before: file.source,
          after: preview.source,
          changed: preview.changed,
          findings: [...preview.findings],
        };
      }),
    };
    const verified = await ctx.runQuery(internal.migrationPreviews.verified, args);
    const previewId = await ctx.runMutation(internal.migrationPreviews.save, {
      ...args,
      reportJson: JSON.stringify(report),
    });
    return { previewId, verified, ...report };
  },
});
export const publish = action({
  args: { previewId: v.string() },
  handler: async (ctx, args): Promise<MigrationPublication> => {
    const preview = await ctx.runQuery(internal.migrationPreviews.owned, args);
    if (
      !(await ctx.runQuery(internal.migrationPreviews.verified, { bindingId: preview.bindingId }))
    )
      throw new ConvexError({
        code: "environment_not_verified",
        nextStep:
          "Complete a successful GitHub job and its runner cleanup on this binding before publishing a migration.",
      });
    const report = Schema.decodeUnknownSync(RepositoryMigration)(JSON.parse(preview.reportJson));
    const files = report.files
      .filter((file) => file.changed)
      .map((file) => ({ path: file.path, mode: file.mode, content: file.after }));
    if (!files.length) throw new ConvexError({ code: "migration_no_changes" });
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: preview.bindingId,
      preparing: true,
    });
    const access = await repositoryAccess(new GitHubAppClient(authority.app), {
      owner: authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      purpose: "migration-write",
    });
    if (access.installationId !== authority.binding.installationId)
      throw new ConvexError({ code: "installation_changed" });
    await ctx.runQuery(internal.migrationPreviews.owned, args);
    const findings = report.files.flatMap((file) =>
      file.findings.map((finding) => `- ${file.path}: ${finding.job}: ${finding.reason}`),
    );
    return publishMigration(
      {
        repositoryId: access.repositoryId,
        owner: authority.account.login,
        repository: authority.binding.repositoryName,
        baseBranch: report.baseBranch,
        baseCommit: report.baseCommit,
        files,
        body: `Move compatible ARM64 workflow jobs to the verified local Vectis environment \`${authority.binding.environmentId}\`. Unchanged jobs retain their existing runners.\n\nReview the workflow diff and required toolchains before merging. The machine must be online to accept jobs.\n\n${findings.length ? "Manual review findings:\n" + findings.join("\n") : "No automatic migration findings."}`,
      },
      access.token,
    );
  },
});
