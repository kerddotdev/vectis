import { restrictiveAccess } from "../../../../packages/github/src/access-policy.js";
import { bindingAuthority } from "../authority.js";
import { CloudError } from "../errors.js";
import { newId } from "../ids.js";
import { machineRecord, type MachineRow, type Binding, type ScaleSetRow } from "../db.js";
import type { Env } from "../env.js";
import type { MachineContext } from "../context.js";
export function assertScaleSetBinding(binding: Binding) {
  if (binding.capacityMode !== "scale_set") throw new CloudError("scale_set_disabled", 409);
  if (!binding.enabled) throw new CloudError("repository_access_denied", 403);
  if (!binding.automatic) throw new CloudError("automatic_disabled", 409);
  if (restrictiveAccess(binding.access))
    throw new CloudError("scale_set_policy_unsupported", 409, {
      message: "Scale set messages do not identify the workflow actor or approval status.",
      nextStep: "Use demand capacity for actor restrictions or required approval.",
    });
}
export async function currentScaleSet(env: Env, binding: Binding, generation: number) {
  const row = await env.DB.prepare(
    "SELECT * FROM runnerScaleSets WHERE bindingId = ? AND machineId = ?",
  )
    .bind(binding.id, binding.machineId)
    .first<ScaleSetRow>();
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !row ||
    row.generation !== generation ||
    row.owner !== binding.owner ||
    row.installationId !== binding.installationId ||
    row.repositoryId !== binding.repositoryId
  )
    throw new CloudError("scale_set_superseded", 409);
  return row;
}
export async function begin(
  c: MachineContext,
  args: { bindingId: string; operation: "open" | "refresh" | "close"; generation?: number },
): Promise<ScaleSetRow> {
  const { binding, account } = await bindingAuthority(
    c.env,
    c.machine,
    args.bindingId,
    args.operation !== "close",
  );
  const existing = await c.env.DB.prepare(
    "SELECT * FROM runnerScaleSets WHERE bindingId = ? AND machineId = ?",
  )
    .bind(binding.id, c.machine.id)
    .first<ScaleSetRow>();
  const busy =
    existing &&
    ["opening", "refreshing", "closing"].includes(existing.phase) &&
    existing.updatedAt > Date.now() - 120000;
  if (args.operation !== "open") {
    const row = await currentScaleSet(c.env, binding, args.generation ?? 0);
    if (row.phase === "deleting") throw new CloudError("scale_set_superseded", 409);
    if (args.operation === "refresh") assertScaleSetBinding(binding);
    if (args.operation === "close" && row.phase === "closed") return row;
    if (
      ["opening", "refreshing", "closing"].includes(row.phase) &&
      row.updatedAt > Date.now() - 120000
    )
      throw new CloudError("scale_set_pending", 409);
    if (
      args.operation === "refresh" &&
      (!["active", "action_required"].includes(row.phase) ||
        !row.sessionId ||
        row.scaleSetId === null)
    )
      throw new CloudError("scale_set_session_missing", 409);
    const phase = args.operation === "refresh" ? "refreshing" : "closing";
    const now = Date.now();
    const changed = await c.env.DB.prepare(
      "UPDATE runnerScaleSets SET phase = ?, updatedAt = ? WHERE id = ? AND generation = ? AND phase = ? AND updatedAt = ?",
    )
      .bind(phase, now, row.id, row.generation, row.phase, row.updatedAt)
      .run();
    if (!changed.meta.changes) throw new CloudError("scale_set_superseded", 409);
    return { ...row, phase, updatedAt: now };
  }
  assertScaleSetBinding(binding);
  if (existing?.phase === "deleting") throw new CloudError("scale_set_cleanup_pending", 409);
  if (busy) throw new CloudError("scale_set_pending", 409);
  if (
    existing?.scaleSetId !== null &&
    existing &&
    (existing.installationId !== binding.installationId ||
      existing.repositoryId !== binding.repositoryId ||
      existing.owner !== binding.owner)
  )
    throw new CloudError("installation_changed", 409);
  const row: ScaleSetRow = {
    id: existing?.id ?? newId(),
    owner: c.machine.owner,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    bindingId: binding.id,
    machineId: c.machine.id,
    repositoryOwner: binding.repositoryOwner ?? account.login,
    repositoryName: binding.repositoryName,
    githubUserId: account.githubId,
    githubLogin: account.login,
    name: `vectis-${binding.environmentId}-${c.machine.id.slice(0, 8)}`,
    generation: (existing?.generation ?? 0) + 1,
    phase: "opening",
    updatedAt: Date.now(),
    scaleSetId: existing?.scaleSetId ?? null,
    sessionId: existing?.sessionId ?? null,
    cleanupDueAt: null,
    cleanupAttempt: 0,
  };
  const fields = [
    "id",
    "owner",
    "installationId",
    "repositoryId",
    "bindingId",
    "machineId",
    "repositoryOwner",
    "repositoryName",
    "githubUserId",
    "githubLogin",
    "name",
    "generation",
    "phase",
    "updatedAt",
  ] as const;
  const values = fields.map((key) => row[key]);
  const result = existing
    ? await c.env.DB.prepare(
        `UPDATE runnerScaleSets SET ${fields.map((key) => `${key} = ?`).join(",")} WHERE id = ? AND generation = ? AND phase = ? AND updatedAt = ?`,
      )
        .bind(...values, existing.id, existing.generation, existing.phase, existing.updatedAt)
        .run()
    : await c.env.DB.prepare(
        `INSERT INTO runnerScaleSets (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT (bindingId,machineId) DO NOTHING`,
      )
        .bind(...values)
        .run();
  if (!result.meta.changes) throw new CloudError("scale_set_pending", 409);
  return row;
}
export async function checkpoint(
  c: MachineContext,
  row: ScaleSetRow,
  phase: "opening" | "active" | "closed",
  scaleSetId?: number,
  sessionId?: string,
) {
  const machine = await c.env.DB.prepare("SELECT * FROM machines WHERE id = ? AND owner = ?")
    .bind(c.machine.id, c.machine.owner)
    .first<MachineRow>();
  if (!machine) throw new CloudError("scale_set_superseded", 409);
  const { binding } = await bindingAuthority(
    c.env,
    machineRecord(machine),
    row.bindingId,
    phase !== "closed",
  );
  if (phase !== "closed") assertScaleSetBinding(binding);
  await currentScaleSet(c.env, binding, row.generation);
  const expected =
    phase === "closed"
      ? ["closing"]
      : phase === "opening"
        ? ["opening"]
        : ["opening", "refreshing"];
  const result = await c.env.DB.prepare(
    `UPDATE runnerScaleSets SET phase = ?, scaleSetId = COALESCE(?,scaleSetId), sessionId = CASE WHEN ? = 'opening' THEN sessionId ELSE ? END, updatedAt = ? WHERE id = ? AND generation = ? AND phase IN (${expected.map(() => "?").join(",")})`,
  )
    .bind(
      phase,
      scaleSetId ?? null,
      phase,
      sessionId ?? null,
      Date.now(),
      row.id,
      row.generation,
      ...expected,
    )
    .run();
  if (!result.meta.changes) throw new CloudError("scale_set_superseded", 409);
}
export async function failed(c: MachineContext, row: ScaleSetRow) {
  await c.env.DB.prepare(
    "UPDATE runnerScaleSets SET phase = 'action_required', updatedAt = ? WHERE id = ? AND generation = ? AND phase IN ('opening','refreshing','closing')",
  )
    .bind(Date.now(), row.id, row.generation)
    .run();
}
