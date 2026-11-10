import type { Env } from "./env.js";
import { socketCloseCodes, type AccountOverview } from "../../../packages/protocol/src/cloud.js";
import type { HumanHandler } from "./context.js";
import { machineRecord, type MachineRow } from "./db.js";
import { CloudError } from "./errors.js";
import { disconnectMachine, machinePresence } from "./notify.js";
import { markScaleSetsForCleanup } from "./runners/scale-sets.js";

export type AccountMachine = AccountOverview["machines"][number];

export async function listMachines(env: Env, owner: string): Promise<AccountMachine[]> {
  const rows = await env.DB.prepare("SELECT * FROM machines WHERE owner = ? LIMIT 100")
    .bind(owner)
    .all<MachineRow>();
  return Promise.all(
    rows.results.map(async (row) => {
      const machine = machineRecord(row);
      const presence = await machinePresence(env, row.id).catch(() => ({
        online: false,
        lastSeenAt: null,
      }));
      return {
        id: row.id,
        localId: row.localId,
        name: row.name,
        createdAt: row.createdAt,
        environments: machine.environments,
        paused: machine.paused ?? false,
        ...presence,
      };
    }),
  );
}

export async function purgeMachine(env: Env, machineId: string): Promise<void> {
  const bindings = await env.DB.prepare("SELECT id FROM repositoryBindings WHERE machineId = ?")
    .bind(machineId)
    .all<{ id: string }>();
  await markScaleSetsForCleanup(
    env,
    bindings.results.map((row) => row.id),
  );
  await disconnectMachine(env, machineId, socketCloseCodes.removed);
  await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(machineId).run();
}

export const removeMachine: HumanHandler<"/machines/remove"> = async ({ env, owner }, { id }) => {
  const machine = await env.DB.prepare("SELECT owner FROM machines WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (machine?.owner !== owner) throw new CloudError("machine_missing", 404);
  await purgeMachine(env, id);
  return null;
};
