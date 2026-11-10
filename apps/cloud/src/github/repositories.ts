import type { Env } from "../env.js";
import {
  machineRecord,
  bindingRecord,
  type Machine,
  type MachineRow,
  type GitHubAccountRow,
  type BindingRow,
  type Binding,
} from "../db.js";
import type { AccountOverview } from "../../../../packages/protocol/src/cloud.js";
import type { MachineRepositories } from "../../../../packages/protocol/src/repositories.js";
import type { HumanHandler, MachineHandler } from "../context.js";
import { bindingAuthority } from "../authority.js";
import { CloudError } from "../errors.js";
import { newId } from "../ids.js";
import { notifyMachine, requestDemand } from "../notify.js";
import { markScaleSetsForCleanup } from "../runners/scale-sets.js";
import { workflowLabel } from "../../../../packages/github/src/runner-labels.js";
import { restrictiveAccess } from "../../../../packages/github/src/access-policy.js";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { RepositoryAccess } from "../../../../packages/protocol/src/repository-access.js";
import {
  CacheVolume,
  defaultCacheSizeGiB,
} from "../../../../packages/protocol/src/cache-volume.js";
import { Schema } from "effect";
import { loadApp } from "./app.js";
import { repositoryAccess } from "./access.js";
export { repositoryReadiness } from "./bindings-readiness.js";

async function authorize(env: Env, owner: string, accountId: string, machineId: string) {
  const [account, target] = await Promise.all([
    env.DB.prepare("SELECT * FROM githubAccounts WHERE id = ?")
      .bind(accountId)
      .first<GitHubAccountRow>(),
    env.DB.prepare(
      "SELECT m.*, c.digest AS credentialDigest FROM machines m JOIN machineCredentials c ON c.machineId = m.id WHERE m.id = ?",
    )
      .bind(machineId)
      .first<MachineRow & { credentialDigest: string }>(),
  ]);
  if (!account || account.owner !== owner || target?.owner !== owner)
    throw new CloudError("repository_access_denied", 403);
  return { account, machine: machineRecord(target), credentialDigest: target.credentialDigest };
}
async function enable(
  env: Env,
  owner: string,
  input: {
    accountId: string;
    machineId: string;
    environmentId: string;
    repositoryName: string;
    repositoryOwner?: string | undefined;
  },
  machineOnly: boolean,
) {
  const initial = await authorize(env, owner, input.accountId, input.machineId);
  if (
    machineOnly &&
    !initial.machine.environments.some((e) => e.id === input.environmentId && e.state === "ready")
  )
    throw new CloudError("environment_unavailable");
  if (
    (input.repositoryOwner !== undefined && !/^[A-Za-z0-9-]+$/.test(input.repositoryOwner)) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(input.environmentId)
  )
    throw new CloudError("invalid_repository_binding");
  const { repositoryId, installationId } = await repositoryAccess(
    new GitHubAppClient(await loadApp(env)),
    {
      owner: input.repositoryOwner ?? initial.account.login,
      githubLogin: initial.account.login,
      repo: input.repositoryName,
      githubUserId: initial.account.githubId,
    },
  );
  const current = await authorize(env, owner, input.accountId, input.machineId);
  if (initial.credentialDigest !== current.credentialDigest)
    throw new CloudError("machine_revoked", 401);
  if (
    machineOnly &&
    !current.machine.environments.some((e) => e.id === input.environmentId && e.state === "ready")
  )
    throw new CloudError("environment_unavailable");
  if (![repositoryId, installationId].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new CloudError("invalid_repository_binding");
  const existing = await env.DB.prepare(
    "SELECT * FROM repositoryBindings WHERE machineId = ? AND repositoryId = ? AND environmentId = ?",
  )
    .bind(input.machineId, repositoryId, input.environmentId)
    .first<BindingRow>();
  if (existing && existing.owner !== owner) throw new CloudError("repository_access_denied", 403);
  if (
    existing &&
    (existing.accountId !== input.accountId || existing.installationId !== installationId)
  )
    await markScaleSetsForCleanup(env, [existing.id]);
  const id = existing?.id ?? newId();
  await env.DB.prepare(
    `INSERT INTO repositoryBindings (id, owner, accountId, machineId, repositoryId, repositoryName, repositoryOwner, installationId, environmentId, enabled, verifiedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ? WHERE ((SELECT COUNT(*) FROM repositoryBindings WHERE machineId = ?) < 100 OR EXISTS (SELECT 1 FROM repositoryBindings WHERE machineId = ? AND repositoryId = ? AND environmentId = ?)) AND EXISTS (SELECT 1 FROM githubAccounts WHERE id = ? AND owner = ?) AND EXISTS (SELECT 1 FROM machines WHERE id = ? AND owner = ?) ON CONFLICT(machineId, repositoryId, environmentId) DO UPDATE SET accountId = excluded.accountId, repositoryName = excluded.repositoryName, repositoryOwner = excluded.repositoryOwner, installationId = excluded.installationId, enabled = 1, verifiedAt = excluded.verifiedAt WHERE repositoryBindings.owner = excluded.owner`,
  )
    .bind(
      id,
      owner,
      input.accountId,
      input.machineId,
      repositoryId,
      input.repositoryName,
      input.repositoryOwner ?? null,
      installationId,
      input.environmentId,
      Date.now(),
      input.machineId,
      input.machineId,
      repositoryId,
      input.environmentId,
      input.accountId,
      owner,
      input.machineId,
      owner,
    )
    .run();
  const saved = await env.DB.prepare(
    "SELECT id FROM repositoryBindings WHERE machineId = ? AND repositoryId = ? AND environmentId = ?",
  )
    .bind(input.machineId, repositoryId, input.environmentId)
    .first<{ id: string }>();
  if (!saved) throw new CloudError("binding_limit");
  await notifyMachine(env, input.machineId);
  return { bindingId: saved.id };
}
export const enableRepository: HumanHandler<"/repositories/enable"> = async (
  { env, owner },
  input,
) => enable(env, owner, input, false);
export const connectRepository: MachineHandler<"/machine/repositories/connect"> = async (
  { env, machine },
  input,
) => enable(env, machine.owner, { ...input, machineId: machine.id }, true);
async function ownedBinding(
  env: Env,
  owner: string,
  id: string,
  machineId?: string,
  enabled = false,
) {
  const row = await env.DB.prepare(
    "SELECT b.* FROM repositoryBindings b JOIN githubAccounts a ON a.id = b.accountId AND a.owner = b.owner WHERE b.id = ? AND b.owner = ?",
  )
    .bind(id, owner)
    .first<BindingRow>();
  if (!row || (machineId && row.machineId !== machineId) || (enabled && !row.enabled))
    throw new CloudError(
      machineId ? "repository_access_denied" : "binding_missing",
      machineId ? 403 : 404,
    );
  return bindingRecord(row);
}
async function machineBinding(env: Env, machine: Machine, id: string) {
  const { binding } = await bindingAuthority(env, machine, id, false);
  if (!binding.enabled) throw new CloudError("repository_access_denied", 403);
  return binding;
}
async function disable(env: Env, binding: Binding) {
  await markScaleSetsForCleanup(env, [binding.id]);
  await env.DB.prepare(
    "UPDATE repositoryBindings SET enabled = 0, automatic = 0, infraRerun = 0 WHERE id = ? AND (enabled != 0 OR automatic != 0 OR infraRerun != 0)",
  )
    .bind(binding.id)
    .run();
  await notifyMachine(env, binding.machineId);
  return null;
}
export const disableRepository: HumanHandler<"/repositories/disable"> = async (
  { env, owner },
  { id },
) => disable(env, await ownedBinding(env, owner, id));
export const disconnectRepository: MachineHandler<"/machine/repositories/disconnect"> = async (
  { env, machine },
  { bindingId },
) => disable(env, await ownedBinding(env, machine.owner, bindingId, machine.id));
async function update(
  env: Env,
  binding: Binding,
  column: string,
  value: string | number,
  demand = false,
) {
  const result = await env.DB.prepare(
    `UPDATE repositoryBindings SET ${column} = ? WHERE id = ? AND ${column} IS NOT ?`,
  )
    .bind(value, binding.id, value)
    .run();
  if (result.meta.changes) {
    await notifyMachine(env, binding.machineId);
    if (demand) await requestDemand(env, binding.machineId);
  }
  return null;
}
function assertPolicy(access: Binding["access"]) {
  if (restrictiveAccess(access))
    throw new CloudError("scale_set_policy_unsupported", 409, {
      message: "Scale set messages do not identify the workflow actor or approval status.",
      nextStep: "Use demand capacity for actor restrictions or required approval.",
    });
}
export const setAutomatic: MachineHandler<"/machine/repositories/set-automatic"> = async (
  { env, machine },
  { bindingId, enabled },
) =>
  update(env, await machineBinding(env, machine, bindingId), "automatic", Number(enabled), enabled);
export const setInfraRerun: MachineHandler<"/machine/repositories/set-infra-rerun"> = async (
  { env, machine },
  { bindingId, enabled },
) => update(env, await machineBinding(env, machine, bindingId), "infraRerun", Number(enabled));
export const setCapacityMode: MachineHandler<"/machine/repositories/set-capacity-mode"> = async (
  { env, machine },
  { bindingId, capacityMode },
) => {
  const binding = await machineBinding(env, machine, bindingId);
  if (capacityMode === "scale_set") assertPolicy(binding.access);
  if (capacityMode === "demand" && binding.capacityMode !== capacityMode)
    await markScaleSetsForCleanup(env, [binding.id]);
  return update(env, binding, "capacityMode", capacityMode, capacityMode === "demand");
};
export const setCacheVolume: MachineHandler<"/machine/repositories/set-cache-volume"> = async (
  { env, machine },
  { bindingId, enabled, sizeGiB },
) => {
  const binding = await machineBinding(env, machine, bindingId);
  const cache = {
    enabled,
    sizeGiB: sizeGiB ?? binding.cacheVolume?.sizeGiB ?? defaultCacheSizeGiB,
  };
  if (!Schema.is(CacheVolume)(cache)) throw new CloudError("invalid_cache_volume");
  return update(env, binding, "cacheVolumeJson", JSON.stringify(cache));
};
export const setAccess: MachineHandler<"/machine/repositories/set-access"> = async (
  { env, machine },
  { bindingId, actors, approval },
) => {
  const binding = await machineBinding(env, machine, bindingId);
  const access = {
    actors: actors === "any" ? ("any" as const) : { ids: [...new Set(actors.ids)] },
    approval,
  };
  if (!Schema.is(RepositoryAccess)(access)) throw new CloudError("invalid_repository_access");
  if (binding.capacityMode === "scale_set") assertPolicy(access);
  return update(env, binding, "accessJson", JSON.stringify(access), true);
};
export async function machineRepositories(
  env: Env,
  machine: Machine,
): Promise<MachineRepositories> {
  const rows = await env.DB.prepare(
    "SELECT b.*, a.login FROM repositoryBindings b JOIN githubAccounts a ON a.id = b.accountId AND a.owner = b.owner WHERE b.machineId = ? AND b.owner = ? AND b.enabled = 1 ORDER BY b.rowid LIMIT 100",
  )
    .bind(machine.id, machine.owner)
    .all<BindingRow & { login: string }>();
  return rows.results.map((row) => {
    const b = bindingRecord(row);
    return {
      id: b.id,
      repositoryId: b.repositoryId,
      installationId: b.installationId,
      repositoryName: `${b.repositoryOwner ?? row.login}/${b.repositoryName}`,
      environmentId: b.environmentId,
      runsOn: workflowLabel(b.environmentId),
      automatic: b.automatic,
      infraRerun: b.infraRerun,
      capacityMode: b.capacityMode,
      ...(b.access ? { access: b.access } : {}),
      ...(b.cacheVolume ? { cacheVolume: b.cacheVolume } : {}),
    };
  });
}
export async function accountBindings(
  env: Env,
  owner: string,
): Promise<AccountOverview["bindings"]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM repositoryBindings WHERE owner = ? ORDER BY rowid LIMIT 100",
  )
    .bind(owner)
    .all<BindingRow>();
  return rows.results.map((row) => {
    const { owner: _owner, ...binding } = bindingRecord(row);
    return { ...binding, runsOn: workflowLabel(binding.environmentId) };
  });
}
export async function purgeBinding(env: Env, bindingId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT machineId FROM repositoryBindings WHERE id = ?")
    .bind(bindingId)
    .first<{ machineId: string }>();
  await markScaleSetsForCleanup(env, [bindingId]);
  await env.DB.prepare("DELETE FROM repositoryBindings WHERE id = ?").bind(bindingId).run();
  if (row) await notifyMachine(env, row.machineId);
}
