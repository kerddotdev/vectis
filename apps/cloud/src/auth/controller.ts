import type { Env } from "../env.js";
import { CloudError } from "../errors.js";
import type { ControllerRow } from "../db.js";
import { sameDigest, sha256Hex } from "../ids.js";

export const unauthorizedController = () =>
  new CloudError("controller_unauthorized", 401, { nextStep: "Sign in again with vectis login." });

export async function authenticateController(
  env: Env,
  header: string | null,
  now = Date.now(),
): Promise<ControllerRow> {
  const match = /^Bearer ([a-z0-9]{1,80})\.([A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (!match?.[1] || !match[2]) throw unauthorizedController();
  const row = await env.DB.prepare("SELECT * FROM controllers WHERE id = ?")
    .bind(match[1])
    .first<ControllerRow>();
  if (
    !row ||
    row.revoked ||
    row.expiresAt <= now ||
    !sameDigest(row.credentialDigest, await sha256Hex(match[2]))
  )
    throw unauthorizedController();
  return row;
}
