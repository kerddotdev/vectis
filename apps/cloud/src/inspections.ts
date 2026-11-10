import type { Env } from "./env.js";
import type { LocalQuery } from "../../../packages/protocol/src/controller.js";
import type { ControllerResponses } from "../../../packages/protocol/src/cloud.js";
import type { MachineHandler } from "./context.js";
import type { InspectionRow } from "./db.js";
import { CloudError } from "./errors.js";
import { newId } from "./ids.js";
import { machinePresence, notifyMachine } from "./notify.js";

export const respond: MachineHandler<"/machine/inspections/respond"> = async (
  { env, machine },
  input,
) => {
  if (new TextEncoder().encode(input.responseJson).byteLength > 262144)
    throw new CloudError("query_result_too_large", 409);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE inspections SET pending = 0, responseJson = ? WHERE id = ? AND machineId = ? AND expiresAt > ? AND pending = 1",
  )
    .bind(input.responseJson, input.id, machine.id, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM inspections WHERE id = ?")
    .bind(input.id)
    .first<InspectionRow>();
  if (!row || row.machineId !== machine.id || row.expiresAt <= now)
    throw new CloudError("query_expired", 409);
  if (row.responseJson !== input.responseJson) throw new CloudError("query_response_conflict", 409);
  return null;
};

export async function submitInspection(
  env: Env,
  owner: string,
  machineId: string,
  key: string,
  query: LocalQuery,
): Promise<ControllerResponses["query.submit"]["Type"]> {
  const machine = await env.DB.prepare("SELECT owner FROM machines WHERE id = ?")
    .bind(machineId)
    .first<{ owner: string }>();
  if (machine?.owner !== owner) throw new CloudError("machine_unavailable", 409);
  if (!(await machinePresence(env, machineId)).online) throw new CloudError("machine_offline", 409);
  const id = newId(),
    now = Date.now(),
    queryJson = JSON.stringify(query);
  await env.DB.prepare(`INSERT INTO inspections (id, owner, machineId, key, queryJson, expiresAt, pending)
    SELECT ?, ?, ?, ?, ?, ?, 1 WHERE (SELECT COUNT(*) FROM inspections WHERE machineId = ? AND pending = 1 AND expiresAt > ?) < 10
    ON CONFLICT(owner, key) DO NOTHING`)
    .bind(id, owner, machineId, key, queryJson, now + 60000, machineId, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM inspections WHERE owner = ? AND key = ?")
    .bind(owner, key)
    .first<InspectionRow>();
  if (!row) throw new CloudError("query_queue_full", 409);
  if (row.machineId !== machineId || row.queryJson !== queryJson)
    throw new CloudError("idempotency_conflict", 409);
  if (row.id === id) await notifyMachine(env, machineId);
  return { queryId: row.id };
}

export async function getInspection(
  env: Env,
  owner: string,
  id: string,
): Promise<ControllerResponses["query.get"]["Type"]> {
  const row = await env.DB.prepare("SELECT * FROM inspections WHERE id = ? AND owner = ?")
    .bind(id, owner)
    .first<InspectionRow>();
  if (!row || row.expiresAt <= Date.now()) throw new CloudError("query_expired", 409);
  return { pending: row.pending === 1, responseJson: row.responseJson };
}
