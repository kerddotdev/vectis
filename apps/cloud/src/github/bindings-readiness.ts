import type { MachineHandler } from "../context.js";
import type { Env } from "../env.js";
import {
  accountRecord,
  bindingRecord,
  type Machine,
  type BindingRow,
  type GitHubAccountRow,
} from "../db.js";
import { CloudError } from "../errors.js";
import { loadApp, hasApp } from "./app.js";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import type {
  RepositoryReadinessInput,
  ReadinessCheck,
} from "../../../../packages/protocol/src/readiness.js";
async function readinessAuthority(env: Env, machine: Machine, input: RepositoryReadinessInput) {
  const credential = await env.DB.prepare(
    "SELECT c.digest FROM machineCredentials c JOIN machines m ON m.id = c.machineId WHERE m.id = ? AND m.owner = ?",
  )
    .bind(machine.id, machine.owner)
    .first<{ digest: string }>();
  if (!credential) throw new CloudError("machine_revoked", 401);
  const accounts = (
    await env.DB.prepare("SELECT * FROM githubAccounts WHERE owner = ? ORDER BY rowid LIMIT 100")
      .bind(machine.owner)
      .all<GitHubAccountRow>()
  ).results.map(accountRecord);
  const bindings = (
    await env.DB.prepare(
      "SELECT * FROM repositoryBindings WHERE machineId = ? ORDER BY rowid LIMIT 100",
    )
      .bind(machine.id)
      .all<BindingRow>()
  ).results.map(bindingRecord);
  const binding =
    "bindingId" in input
      ? bindings.find((b) => b.id === input.bindingId)
      : bindings
          .toSorted((a, b) => Number(b.enabled) - Number(a.enabled))
          .find((b) => {
            const account = accounts.find((a) => a.id === b.accountId);
            return (
              b.owner === machine.owner &&
              account &&
              `${b.repositoryOwner ?? account.login}/${b.repositoryName}`.toLowerCase() ===
                input.repositoryName.toLowerCase() &&
              (input.environmentId === undefined || input.environmentId === b.environmentId)
            );
          });
  if (("bindingId" in input && !binding) || (binding && binding.owner !== machine.owner))
    throw new CloudError("repository_access_denied", 403);
  const account = binding ? accounts.find((a) => a.id === binding.accountId) : undefined;
  if (binding && !account) throw new CloudError("repository_access_denied", 403);
  return {
    credentialDigest: credential.digest,
    repositoryName:
      "repositoryName" in input
        ? input.repositoryName
        : `${binding?.repositoryOwner ?? account?.login}/${binding?.repositoryName}`,
    environmentId:
      "environmentId" in input
        ? (input.environmentId ?? binding?.environmentId)
        : binding?.environmentId,
    accounts: (binding ? (account ? [account] : []) : accounts).map(({ githubId, login }) => ({
      githubId,
      login,
    })),
    binding: binding
      ? {
          enabled: binding.enabled,
          automatic: binding.automatic,
          infraRerun: binding.infraRerun,
          repositoryId: binding.repositoryId,
          installationId: binding.installationId,
          cacheVolumeEnabled: binding.cacheVolume?.enabled ?? false,
        }
      : null,
    app: (await hasApp(env)) ? await loadApp(env) : null,
  };
}
export const repositoryReadiness: MachineHandler<"/machine/repositories/readiness"> = async (
  c,
  { input },
) => {
  const authority = await readinessAuthority(c.env, c.machine, input);
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
  const current = await readinessAuthority(c.env, c.machine, input);
  if (JSON.stringify(authority) !== JSON.stringify(current))
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
};
