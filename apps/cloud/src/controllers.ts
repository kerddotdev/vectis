import type { HumanHandler, RawHandler } from "./context.js";
import { PairingSecret } from "../../../packages/protocol/src/cloud.js";
import { ControllerRequest } from "../../../packages/protocol/src/controller.js";
import type { ControllerRow } from "./db.js";
import { CloudError } from "./errors.js";
import { decode, json, readJson } from "./http.js";
import { newId, sha256Hex } from "./ids.js";
import { authenticateController } from "./auth/controller.js";
import { submitOperation, cancelOperation, getOperation } from "./operations.js";
import { submitInspection, getInspection } from "./inspections.js";
import { listMachines } from "./machines.js";
export const approveController: HumanHandler<"/controllers/approve"> = async (
  { env, owner },
  input,
) => {
  const now = Date.now();
  if (
    !input.name.trim() ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + 600000
  )
    throw new CloudError("invalid_controller_request");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO controllers (id, owner, name, requestDigest, credentialDigest, pairingExpiresAt, expiresAt, revoked, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM controllers WHERE owner = ? AND revoked = 0 AND expiresAt > ?) < 20 ON CONFLICT(requestDigest) DO NOTHING`,
  )
    .bind(
      id,
      owner,
      input.name,
      input.requestDigest,
      input.credentialDigest,
      input.expiresAt,
      now + 90 * 86400000,
      now,
      owner,
      now,
    )
    .run();
  const row = await env.DB.prepare("SELECT * FROM controllers WHERE requestDigest = ?")
    .bind(input.requestDigest)
    .first<ControllerRow>();
  if (!row)
    throw new CloudError("controller_limit", 409, {
      nextStep: "Revoke an unused CLI or desktop connection.",
    });
  if (
    row.owner !== owner ||
    row.revoked ||
    row.name !== input.name ||
    row.credentialDigest !== input.credentialDigest ||
    row.pairingExpiresAt !== input.expiresAt
  )
    throw new CloudError("controller_conflict");
  return { controllerId: row.id };
};
export const revokeController: HumanHandler<"/controllers/revoke"> = async (
  { env, owner },
  { id },
) => {
  const row = await env.DB.prepare("SELECT owner FROM controllers WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (row?.owner !== owner) throw new CloudError("controller_missing", 404);
  await env.DB.prepare("UPDATE controllers SET revoked = 1 WHERE id = ? AND revoked = 0")
    .bind(id)
    .run();
  return null;
};
export const controllerPairing: RawHandler = async ({ env }, request) => {
  const { secret } = decode(PairingSecret, await readJson(request, 4096));
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT id AS controllerId, expiresAt FROM controllers WHERE requestDigest = ? AND revoked = 0 AND pairingExpiresAt > ? AND expiresAt > ?",
  )
    .bind(await sha256Hex(secret), now, now)
    .first<{ controllerId: string; expiresAt: number }>();
  return json(row ?? { state: "pending" });
};
export const controllerRequest: RawHandler = async ({ env }, request) => {
  try {
    const controller = await authenticateController(env, request.headers.get("Authorization"));
    const input = decode(ControllerRequest, await readJson(request, 65536));
    const owner = controller.owner;
    switch (input.type) {
      case "operation.submit":
        return json({
          operationId: await submitOperation(env, owner, {
            ...input,
            commandJson: JSON.stringify(input.command),
          }),
        });
      case "operation.cancel":
        return json({ operationId: await cancelOperation(env, owner, input.id) });
      case "operation.get":
        return json(await getOperation(env, owner, input.id));
      case "query.submit":
        return json(await submitInspection(env, owner, input.machineId, input.key, input.query));
      case "query.get":
        return json(await getInspection(env, owner, input.id));
      case "machines.list":
        return json(
          (await listMachines(env, owner)).map(
            ({ id, localId, name, lastSeenAt, online, environments, paused }) => ({
              id,
              localId,
              name,
              lastSeenAt,
              online,
              environments,
              paused,
            }),
          ),
        );
      case "controller.revoke":
        await env.DB.prepare("UPDATE controllers SET revoked = 1 WHERE id = ?")
          .bind(controller.id)
          .run();
        return json({ revoked: true });
    }
  } catch (error) {
    if (error instanceof CloudError)
      return json(error.body(), error.code === "controller_unauthorized" ? 401 : 409);
    throw error;
  }
};
