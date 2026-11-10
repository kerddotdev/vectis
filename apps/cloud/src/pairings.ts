import { PairingSecret, socketCloseCodes } from "../../../packages/protocol/src/cloud.js";
import type { HumanHandler, RawHandler } from "./context.js";
import { CloudError } from "./errors.js";
import { decode, json, readJson } from "./http.js";
import { newId, sha256Hex } from "./ids.js";
import { disconnectMachine } from "./notify.js";
import type { MachineRow, PairingRow } from "./db.js";

export const approvePairing: HumanHandler<"/pairings/approve"> = async ({ env, owner }, input) => {
  const now = Date.now();
  if (
    !input.name.trim() ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + 600000
  )
    throw new CloudError("invalid_pairing");
  const previous = await env.DB.prepare("SELECT * FROM pairings WHERE requestDigest = ?")
    .bind(input.requestDigest)
    .first<PairingRow>();
  if (previous) {
    const machine = await env.DB.prepare(
      "SELECT m.*, c.digest FROM machines m JOIN machineCredentials c ON c.machineId = m.id WHERE m.id = ?",
    )
      .bind(previous.machineId)
      .first<MachineRow & { digest: string }>();
    if (
      previous.owner !== owner ||
      previous.expiresAt !== input.expiresAt ||
      machine?.localId !== input.localId ||
      machine.name !== input.name ||
      machine.digest !== input.credentialDigest
    )
      throw new CloudError("pairing_conflict");
    return { machineId: previous.machineId };
  }
  const id = newId();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM pairings WHERE owner = ? AND expiresAt <= ?").bind(owner, now),
    env.DB.prepare(
      `INSERT INTO machines (id, owner, localId, name, createdAt) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM machines WHERE owner = ?) < 100 AND (SELECT COUNT(*) FROM pairings WHERE owner = ?) < 10 AND NOT EXISTS (SELECT 1 FROM pairings WHERE requestDigest = ?) ON CONFLICT(owner, localId) DO NOTHING`,
    ).bind(id, owner, input.localId, input.name, now, owner, owner, input.requestDigest),
    env.DB.prepare(
      `INSERT INTO pairings (requestDigest, owner, machineId, expiresAt) SELECT ?, ?, m.id, ? FROM machines m WHERE m.owner = ? AND m.localId = ? AND (SELECT COUNT(*) FROM pairings WHERE owner = ? AND expiresAt > ?) < 10 ON CONFLICT DO NOTHING`,
    ).bind(input.requestDigest, owner, input.expiresAt, owner, input.localId, owner, now),
    env.DB.prepare(
      `INSERT INTO machineCredentials (machineId, digest, createdAt) SELECT machineId, ?, ? FROM pairings WHERE requestDigest = ? AND changes() = 1 ON CONFLICT(machineId) DO UPDATE SET digest = excluded.digest, createdAt = excluded.createdAt`,
    ).bind(input.credentialDigest, now, input.requestDigest),
    env.DB.prepare(
      "UPDATE machines SET name = ? WHERE changes() = 1 AND id = (SELECT machineId FROM pairings WHERE requestDigest = ?)",
    ).bind(input.name, input.requestDigest),
    env.DB.prepare(
      "DELETE FROM pairings WHERE changes() = 1 AND machineId = (SELECT machineId FROM pairings WHERE requestDigest = ?) AND requestDigest != ?",
    ).bind(input.requestDigest, input.requestDigest),
  ]);
  if (!results[2]?.meta.changes) {
    const raced = await env.DB.prepare("SELECT * FROM pairings WHERE requestDigest = ?")
      .bind(input.requestDigest)
      .first<PairingRow>();
    if (raced) {
      const current = await env.DB.prepare(
        "SELECT m.*, c.digest FROM machines m JOIN machineCredentials c ON c.machineId = m.id WHERE m.id = ?",
      )
        .bind(raced.machineId)
        .first<MachineRow & { digest: string }>();
      if (
        raced.owner === owner &&
        raced.expiresAt === input.expiresAt &&
        current?.localId === input.localId &&
        current.name === input.name &&
        current.digest === input.credentialDigest
      )
        return { machineId: raced.machineId };
      throw new CloudError("pairing_conflict");
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pairings WHERE owner = ? AND expiresAt > ?",
    )
      .bind(owner, now)
      .first<number>("n");
    throw new CloudError(count !== null && count >= 10 ? "pairing_rate_limit" : "machine_limit");
  }
  const machine = await env.DB.prepare(
    "SELECT machineId AS id FROM pairings WHERE requestDigest = ?",
  )
    .bind(input.requestDigest)
    .first<{ id: string }>();
  if (!machine) throw new CloudError("pairing_conflict");
  await disconnectMachine(env, machine.id, socketCloseCodes.replaced);
  return { machineId: machine.id };
};
export const machinePairing: RawHandler = async ({ env }, request) => {
  const { secret } = decode(PairingSecret, await readJson(request, 4096));
  const row = await env.DB.prepare(
    "SELECT p.machineId, m.localId FROM pairings p JOIN machines m ON m.id = p.machineId WHERE p.requestDigest = ? AND p.expiresAt > ?",
  )
    .bind(await sha256Hex(secret), Date.now())
    .first<{ machineId: string; localId: string }>();
  return json(row ?? { state: "pending" });
};
