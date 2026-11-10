import type { Env } from "./env.js";
import type { ControllerResponses } from "../../../packages/protocol/src/cloud.js";
import { decodeCommand } from "../../../packages/protocol/src/index.js";
import type { MachineHandler, Sweep } from "./context.js";
import type { OperationRow } from "./db.js";
import { CloudError } from "./errors.js";
import { newId } from "./ids.js";
import { machinePresence, notifyMachine, requestDemand } from "./notify.js";

const terminal = (phase: string) =>
  ["succeeded", "failed", "cancelled", "action_required"].includes(phase);
const allowed: Record<OperationRow["phase"], readonly string[]> = {
  accepted: ["claimed"],
  claimed: ["running", "failed", "action_required", "cancelled"],
  running: ["succeeded", "failed", "action_required", "cancelled"],
  succeeded: [],
  failed: [],
  action_required: [],
  cancelled: [],
};
export const acknowledge: MachineHandler<"/machine/operations/acknowledge"> = async (
  { env, machine },
  input,
) => {
  for (;;) {
    const row = await env.DB.prepare("SELECT * FROM operations WHERE id = ?")
      .bind(input.id)
      .first<OperationRow>();
    if (!row || row.machineId !== machine.id) throw new CloudError("operation_missing", 404);
    if (input.resultJson && input.resultJson.length > 16384)
      throw new CloudError("result_too_large", 409);
    if (row.phase === input.phase) {
      if ((row.resultJson ?? undefined) !== input.resultJson)
        throw new CloudError("acknowledgement_conflict", 409);
      return null;
    }
    if (row.phase === "cancelled" && input.phase === "claimed")
      throw new CloudError("operation_cancelled", 409);
    if (!allowed[row.phase].includes(input.phase)) throw new CloudError("invalid_transition", 409);
    const result = await env.DB.prepare(
      "UPDATE operations SET phase = ?, updatedAt = ?, resultJson = ? WHERE id = ? AND phase = ?",
    )
      .bind(input.phase, Date.now(), input.resultJson ?? row.resultJson, row.id, row.phase)
      .run();
    if (!result.meta.changes) continue;
    if (terminal(input.phase) && decodeCommand(JSON.parse(row.commandJson)).type === "runner.run")
      await requestDemand(env, machine.id);
    return null;
  }
};

export async function submitOperation(
  env: Env,
  owner: string,
  input: { machineId: string; key: string; commandJson: string },
): Promise<string> {
  const machine = await env.DB.prepare("SELECT owner FROM machines WHERE id = ?")
    .bind(input.machineId)
    .first<{ owner: string }>();
  if (machine?.owner !== owner) throw new CloudError("machine_unavailable", 409);
  if (!input.key || input.key.length > 200 || input.commandJson.length > 65536)
    throw new CloudError("invalid_request", 409);
  let commandJson: string;
  try {
    commandJson = JSON.stringify(decodeCommand(JSON.parse(input.commandJson)));
  } catch {
    throw new CloudError("invalid_command", 409);
  }
  const id = newId(),
    now = Date.now();
  await env.DB.prepare(`INSERT INTO operations (id, owner, machineId, key, commandJson, phase, createdAt, updatedAt)
    SELECT ?, ?, ?, ?, ?, 'accepted', ?, ? WHERE (SELECT COUNT(*) FROM operations WHERE machineId = ? AND phase = 'accepted') < 100
    ON CONFLICT(owner, key) DO NOTHING`)
    .bind(id, owner, input.machineId, input.key, commandJson, now, now, input.machineId)
    .run();
  const row = await env.DB.prepare("SELECT * FROM operations WHERE owner = ? AND key = ?")
    .bind(owner, input.key)
    .first<OperationRow>();
  if (!row) throw new CloudError("queue_full", 409);
  if (row.machineId !== input.machineId || row.commandJson !== commandJson)
    throw new CloudError("idempotency_conflict", 409);
  if (row.id === id) await notifyMachine(env, input.machineId);
  return row.id;
}

export async function cancelOperation(env: Env, owner: string, id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT * FROM operations WHERE id = ? AND owner = ?")
    .bind(id, owner)
    .first<OperationRow>();
  if (!row) throw new CloudError("operation_missing", 404);
  if (!terminal(row.phase)) {
    await env.DB.prepare(
      `UPDATE operations SET cancelRequested = 1, updatedAt = ?, phase = CASE WHEN phase = 'accepted' THEN 'cancelled' ELSE phase END WHERE id = ? AND phase IN ('accepted', 'claimed', 'running')`,
    )
      .bind(Date.now(), id)
      .run();
    await notifyMachine(env, row.machineId);
  }
  return id;
}

export async function getOperation(
  env: Env,
  owner: string,
  id: string,
): Promise<ControllerResponses["operation.get"]["Type"]> {
  const row = await env.DB.prepare("SELECT * FROM operations WHERE id = ? AND owner = ?")
    .bind(id, owner)
    .first<OperationRow>();
  if (!row) throw new CloudError("operation_missing", 404);
  return {
    id: row.id,
    machineId: row.machineId,
    key: row.key,
    commandJson: row.commandJson,
    phase: row.phase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resultJson === null ? {} : { resultJson: row.resultJson }),
  };
}

export const sweepOperations: Sweep = async (env, now) => {
  const rows = await env.DB.prepare(
    "SELECT * FROM operations INDEXED BY operations_accepted WHERE phase = 'accepted' AND createdAt <= ? AND json_extract(commandJson, '$.type') = 'runner.run' ORDER BY createdAt LIMIT 100",
  )
    .bind(now - 120000)
    .all<OperationRow>();
  for (const row of rows.results) {
    if (decodeCommand(JSON.parse(row.commandJson)).type !== "runner.run") continue;
    const online = (await machinePresence(env, row.machineId).catch(() => ({ online: false })))
      .online;
    if (online && row.createdAt + 600000 > now) continue;
    const resultJson = JSON.stringify({
      status: "cancelled",
      code: online ? "claim_timeout" : "machine_offline",
      message: online
        ? "The machine did not claim this runner request within ten minutes."
        : "The machine went offline before it claimed this runner request.",
      resultAvailableLocally: false,
    });
    const result = await env.DB.prepare(
      "UPDATE operations SET phase = 'cancelled', updatedAt = ?, resultJson = ? WHERE id = ? AND phase = 'accepted'",
    )
      .bind(now, resultJson, row.id)
      .run();
    if (result.meta.changes) await notifyMachine(env, row.machineId);
  }
};
