import { Schema } from "effect";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { readRepositoryWorkflows } from "../../../../packages/github/src/workflow-repository.js";
import { publishMigration as publishPullRequest } from "../../../../packages/github/src/migration-pr.js";
import { previewMigration } from "../../../../packages/migration/src/index.js";
import { RepositoryMigration } from "../../../../packages/protocol/src/migrations.js";
import { bindingAuthority } from "../authority.js";
import type { MachineContext, MachineHandler } from "../context.js";
import { machineRecord, type MachineRow, type MigrationPreviewRow } from "../db.js";
import { VectisError } from "../../../../packages/protocol/src/index.js";
import { CloudError } from "../errors.js";
import { newId } from "../ids.js";
import { loadApp } from "./app.js";
import { githubErrors, repositoryAccess } from "./access.js";

async function migrationErrors<T>(operation: () => Promise<T>) {
  try {
    return await githubErrors(operation);
  } catch (error) {
    if (error instanceof VectisError)
      throw new CloudError(error.code, 409, { message: error.message, nextStep: error.nextStep });
    throw error;
  }
}

async function currentMachine(c: MachineContext) {
  const row = await c.env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(c.machine.id)
    .first<MachineRow>();
  if (!row || row.owner !== c.machine.owner) throw new CloudError("machine_revoked", 401);
  return machineRecord(row);
}

async function verified(c: MachineContext, bindingId: string) {
  const { binding, environment } = await bindingAuthority(c.env, c.machine, bindingId, true);
  if (!environment?.revision) return false;
  const row = await c.env.DB.prepare(`SELECT 1 AS found FROM
    (SELECT * FROM runnerLeases WHERE machineId = ? AND phase = 'released' ORDER BY rowid DESC LIMIT 100) l
    JOIN (SELECT * FROM githubJobs WHERE installationId = ? AND repositoryId = ? ORDER BY updatedAt DESC LIMIT 100) j
    ON j.runnerId = l.runnerId
    WHERE l.bindingId = ? AND l.environmentRevision = ? AND l.owner = ?
    AND l.runnerId IS NOT NULL AND j.status = 'completed' AND j.conclusion = 'success' LIMIT 1`)
    .bind(
      c.machine.id,
      binding.installationId,
      binding.repositoryId,
      binding.id,
      environment.revision,
      c.machine.owner,
    )
    .first();
  return row !== null;
}

async function owned(c: MachineContext, previewId: string) {
  const preview = await c.env.DB.prepare("SELECT * FROM migrationPreviews WHERE id = ?")
    .bind(previewId)
    .first<MigrationPreviewRow>();
  if (
    !preview ||
    preview.owner !== c.machine.owner ||
    preview.machineId !== c.machine.id ||
    preview.expiresAt < Date.now()
  )
    throw new CloudError("migration_preview_unavailable", 404);
  const { environment } = await bindingAuthority(
    c.env,
    await currentMachine(c),
    preview.bindingId,
    true,
  );
  if (!preview.environmentRevision || preview.environmentRevision !== environment?.revision)
    throw new CloudError("migration_environment_changed", 409);
  return preview;
}

export const analyzeMigration: MachineHandler<"/machine/migrations/analyze"> = async (c, args) =>
  migrationErrors(async () => {
    const { binding, account, environment } = await bindingAuthority(
      c.env,
      c.machine,
      args.bindingId,
      true,
    );
    if (!environment) throw new CloudError("environment_unavailable", 409);
    const client = new GitHubAppClient(await loadApp(c.env));
    const access = await repositoryAccess(client, {
      owner: binding.repositoryOwner ?? account.login,
      repo: binding.repositoryName,
      repositoryId: binding.repositoryId,
      githubUserId: account.githubId,
      githubLogin: account.login,
      purpose: "migration-read",
    });
    if (access.installationId !== binding.installationId)
      throw new CloudError("installation_changed", 409);
    const source = await readRepositoryWorkflows(
      (path) => client.request(access.token, access.path + path),
      access.repositoryId,
    );
    const labels =
      environment.os === "linux"
        ? ["ubuntu-24.04-arm", "ubuntu-24.04", "ubuntu-latest"]
        : environment.os === "windows"
          ? ["windows-11-arm", "windows-latest", "windows-2025", "windows-2022"]
          : ["macos-27", "macos-26", "macos-latest"];
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
          ...(preview.jobs ? { jobs: [...preview.jobs] } : {}),
        };
      }),
    };
    const isVerified = await verified(c, args.bindingId);
    const current = await bindingAuthority(c.env, await currentMachine(c), args.bindingId, true);
    if (
      current.environment?.revision !== environment.revision ||
      current.binding.environmentId !== binding.environmentId
    )
      throw new CloudError("migration_environment_changed", 409);
    const reportJson = JSON.stringify(report);
    if (new TextEncoder().encode(reportJson).length > 768 * 1024)
      throw new CloudError("migration_preview_too_large", 409);
    const previewId = newId();
    const now = Date.now();
    const result =
      await c.env.DB.prepare(`INSERT INTO migrationPreviews (id, owner, machineId, bindingId, reportJson, environmentRevision, createdAt, expiresAt)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM migrationPreviews WHERE machineId = ? AND expiresAt >= ?) < 100`)
        .bind(
          previewId,
          c.machine.owner,
          c.machine.id,
          current.binding.id,
          reportJson,
          current.environment?.revision ?? null,
          now,
          now + 86400000,
          c.machine.id,
          now,
        )
        .run();
    if (!result.meta.changes) throw new CloudError("migration_preview_limit", 409);
    return { previewId, verified: isVerified, ...report };
  });

export const publishMigration: MachineHandler<"/machine/migrations/publish"> = async (c, args) =>
  migrationErrors(async () => {
    const preview = await owned(c, args.previewId);
    if (!(await verified(c, preview.bindingId)))
      throw new CloudError("environment_not_verified", 409, {
        nextStep:
          "Complete a successful GitHub job and its runner cleanup on this binding before publishing a migration.",
      });
    const report = Schema.decodeUnknownSync(RepositoryMigration)(JSON.parse(preview.reportJson));
    const files = report.files
      .filter((file) => file.changed)
      .map((file) => ({ path: file.path, mode: file.mode, content: file.after }));
    if (!files.length) throw new CloudError("migration_no_changes", 409);
    const { binding, account } = await bindingAuthority(c.env, c.machine, preview.bindingId, true);
    const access = await repositoryAccess(new GitHubAppClient(await loadApp(c.env)), {
      owner: binding.repositoryOwner ?? account.login,
      repo: binding.repositoryName,
      repositoryId: binding.repositoryId,
      githubUserId: account.githubId,
      githubLogin: account.login,
      purpose: "migration-write",
    });
    if (access.installationId !== binding.installationId)
      throw new CloudError("installation_changed", 409);
    await owned(c, args.previewId);
    const findings = report.files.flatMap((file) =>
      file.findings.map((finding) => `- ${file.path}: ${finding.job}: ${finding.reason}`),
    );
    return publishPullRequest(
      {
        repositoryId: access.repositoryId,
        owner: binding.repositoryOwner ?? account.login,
        repository: binding.repositoryName,
        baseBranch: report.baseBranch,
        baseCommit: report.baseCommit,
        files,
        body: `Move compatible ARM64 workflow jobs to the verified local Vectis environment \`${binding.environmentId}\`. Unchanged jobs retain their existing runners.\n\nReview the workflow diff and required toolchains before merging. The machine must be online to accept jobs.\n\n${findings.length ? "Manual review findings:\n" + findings.join("\n") : "No automatic migration findings."}`,
      },
      access.token,
    );
  });
