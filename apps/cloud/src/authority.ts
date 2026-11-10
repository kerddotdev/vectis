import type { Env } from "./env.js";
import { CloudError } from "./errors.js";
import {
  accountRecord,
  bindingRecord,
  type BindingRow,
  type GitHubAccountRow,
  type Machine,
} from "./db.js";

// A machine may act on a binding only while the binding, its machine and its verified GitHub
// account all belong to the same owner. Preparing a runner also needs an enabled binding and a
// ready environment.
export async function bindingAuthority(
  env: Env,
  machine: Machine,
  bindingId: string,
  preparing: boolean,
) {
  const [bindingRow, accountRow] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM repositoryBindings WHERE id = ?").bind(bindingId),
    env.DB.prepare(
      "SELECT a.* FROM githubAccounts a JOIN repositoryBindings b ON b.accountId = a.id WHERE b.id = ?",
    ).bind(bindingId),
  ]);
  const row = bindingRow?.results[0] as BindingRow | undefined;
  const accountValue = accountRow?.results[0] as GitHubAccountRow | undefined;
  if (
    !row ||
    row.machineId !== machine.id ||
    row.owner !== machine.owner ||
    (preparing && !row.enabled)
  )
    throw new CloudError("repository_access_denied", 403);
  if (!accountValue || accountValue.owner !== machine.owner)
    throw new CloudError("repository_access_denied", 403);
  const binding = bindingRecord(row);
  const environment = machine.environments.find((item) => item.id === binding.environmentId);
  if (preparing && environment?.state !== "ready")
    throw new CloudError("environment_unavailable", 409, {
      nextStep: "Prepare the environment and reconnect the machine.",
    });
  return { machine, binding, account: accountRecord(accountValue), environment };
}
