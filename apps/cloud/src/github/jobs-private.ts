import type { Env } from "../env.js";
import { bindingRecord, accountRecord, type BindingRow, type GitHubAccountRow } from "../db.js";
import { restrictiveAccess } from "../../../../packages/github/src/access-policy.js";
import { bindingAuthority } from "../authority.js";
import type { MachineContext } from "../context.js";
import { CloudError } from "../errors.js";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { loadApp } from "./app.js";
import { repositoryAccess } from "./access.js";

export async function restrictiveAuthority(env: Env, installationId: number, repositoryId: number) {
  const rows = await env.DB.prepare(`SELECT b.* FROM repositoryBindings b
    JOIN machines m ON m.id = b.machineId AND m.owner = b.owner
    JOIN githubAccounts a ON a.id = b.accountId AND a.owner = b.owner
    WHERE b.installationId = ? AND b.repositoryId = ? AND b.enabled = 1 LIMIT 100`)
    .bind(installationId, repositoryId)
    .all<BindingRow>();
  for (const row of rows.results) {
    const binding = bindingRecord(row);
    if (!restrictiveAccess(binding.access)) continue;
    const account = await env.DB.prepare("SELECT * FROM githubAccounts WHERE id = ?")
      .bind(binding.accountId)
      .first<GitHubAccountRow>();
    if (account) return { binding, account: accountRecord(account) };
  }
  return null;
}

export async function jobAuthority(c: MachineContext, bindingId: string) {
  const authority = await bindingAuthority(c.env, c.machine, bindingId, false);
  if (!authority.binding.enabled) throw new CloudError("repository_access_denied", 403);
  return authority;
}
export async function githubAuthority(c: MachineContext, bindingId: string) {
  const authority = await jobAuthority(c, bindingId);
  const client = new GitHubAppClient(await loadApp(c.env));
  const access = await accessFor(client, authority);
  return { ...authority, client, access };
}
export async function accessFor(
  client: GitHubAppClient,
  authority: NonNullable<Awaited<ReturnType<typeof restrictiveAuthority>>>,
) {
  const { binding, account } = authority;
  const access = await repositoryAccess(client, {
    owner: binding.repositoryOwner ?? account.login,
    repo: binding.repositoryName,
    repositoryId: binding.repositoryId,
    githubUserId: account.githubId,
    githubLogin: account.login,
    purpose: "jobs",
  });
  if (access.installationId !== binding.installationId)
    throw new CloudError("installation_changed", 409);
  return access;
}
export async function pendingRuns(env: Env, installationId: number, repositoryId: number) {
  const results = await env.DB.batch<{ runId: number }>(
    ["queued", "in_progress", "waiting"].map((status) =>
      env.DB.prepare(
        "SELECT runId FROM githubJobs WHERE installationId = ? AND repositoryId = ? AND status = ? LIMIT 101",
      ).bind(installationId, repositoryId, status),
    ),
  );
  return {
    runIds: [
      ...new Set(results.flatMap((result) => result.results.slice(0, 100).map((row) => row.runId))),
    ],
    complete: results.every((result) => result.results.length <= 100),
  };
}
