import type { Env } from "../env.js";
import { CloudError, unauthorizedMachine } from "../errors.js";
import { machineRecord, type Machine, type MachineRow } from "../db.js";
import { sameDigest, sha256Hex } from "../ids.js";

const bearer = /^([a-z0-9]{1,80})\.([A-Za-z0-9_-]{43})$/;

export const machineRevoked = () =>
  new CloudError("machine_revoked", 401, {
    nextStep: "This machine was removed from its account. Disconnect it, then pair it again.",
  });

// Every machine request carries `<machineId>.<secret>`; the cloud stores only the secret's digest.
export async function authenticateMachine(env: Env, credential: string | null): Promise<Machine> {
  const match = credential === null ? null : bearer.exec(credential);
  if (!match?.[1] || !match[2]) throw unauthorizedMachine();
  const row = await env.DB.prepare(
    "SELECT m.*, c.digest FROM machines m JOIN machineCredentials c ON c.machineId = m.id WHERE m.id = ?",
  )
    .bind(match[1])
    .first<MachineRow & { digest: string }>();
  if (!row || !sameDigest(row.digest, await sha256Hex(match[2]))) throw machineRevoked();
  const { digest: _digest, ...machine } = row;
  return machineRecord(machine);
}

export function bearerCredential(request: Request) {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

// Browsers and Node's WebSocket cannot set headers on the upgrade, so the credential travels as a
// second subprotocol: "vectis.v1, auth.<base64url(machineId.secret)>".
export function socketCredential(request: Request) {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((item) => item.trim());
  const encoded = offered.find((item) => item.startsWith("auth."))?.slice(5);
  if (!offered.includes("vectis.v1") || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    return atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}
