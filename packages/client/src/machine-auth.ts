import { createHash } from "node:crypto";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
import { CloudUrl } from "../../protocol/src/cloud-url.js";
import type { KeychainCredentials } from "./keychain.js";

export const CloudConnection = Schema.Struct({
  deploymentUrl: CloudUrl,
  machineId: Schema.NonEmptyString,
  localId: Schema.NonEmptyString,
});
export type CloudConnection = typeof CloudConnection.Type;

export function credentialAccount(connection: CloudConnection) {
  return createHash("sha256")
    .update(JSON.stringify([connection.deploymentUrl, connection.machineId]))
    .digest("hex");
}

// The machine authenticates every request with its pairing secret; there is no token exchange.
// Null means the Keychain no longer holds the credential.
export async function machineBearer(
  connection: CloudConnection,
  credentials: Pick<KeychainCredentials, "get">,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const secret = await credentials.get(credentialAccount(connection), signal);
  if (!secret) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new VectisError("machine_rejected", "The stored machine credential is malformed.");
  return `${connection.machineId}.${secret}`;
}
