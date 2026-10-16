import { createHash } from "node:crypto";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
import type { KeychainCredentials } from "./keychain.js";

export const CloudConnection = Schema.Struct({
  deploymentUrl: Schema.String,
  machineId: Schema.NonEmptyString,
  localId: Schema.NonEmptyString,
});
export type CloudConnection = typeof CloudConnection.Type;

export function machineEndpoint(deploymentUrl: string) {
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(deploymentUrl))
    throw new VectisError(
      "invalid_cloud_url",
      "Machine authentication requires a canonical HTTPS Convex deployment URL.",
    );
  return deploymentUrl.replace(/\.cloud$/, ".site") + "/machine/token";
}
export function credentialAccount(connection: CloudConnection) {
  machineEndpoint(connection.deploymentUrl);
  return createHash("sha256")
    .update(JSON.stringify([connection.deploymentUrl, connection.machineId]))
    .digest("hex");
}

const Token = Schema.Struct({ token: Schema.NonEmptyString, expiresAt: Schema.Number });
export function machineTokenFetcher(
  connection: CloudConnection,
  credentials: Pick<KeychainCredentials, "get">,
  signal: AbortSignal,
) {
  const endpoint = machineEndpoint(connection.deploymentUrl);
  const account = credentialAccount(connection);
  let cached: typeof Token.Type | undefined;
  let previousToken: string | undefined;
  return async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    signal.throwIfAborted();
    if (!forceRefreshToken && cached && cached.expiresAt > Date.now() + 30000) return cached.token;
    cached = undefined;
    const secret = await credentials.get(account, signal);
    if (!secret) return null;
    const request = async () => {
      signal.throwIfAborted();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId: connection.machineId, secret }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (response.status === 401)
        throw new VectisError(
          "machine_rejected",
          "This machine is no longer connected to the account.",
          "Run vectis cloud disconnect on this Mac, then pair it again.",
        );
      if (!response.ok)
        throw new VectisError(
          "cloud_unavailable",
          "Machine authentication is temporarily unavailable.",
        );
      const token = Schema.decodeUnknownSync(Token)(await response.json());
      if (token.expiresAt <= Date.now())
        throw new VectisError(
          "invalid_machine_token",
          "Machine authentication returned an expired token.",
        );
      return token;
    };
    let token = await request();
    if (forceRefreshToken && token.token === previousToken) {
      // Convex stops scheduling refreshes when it receives the same token again.
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 1100);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      token = await request();
    }
    cached = token;
    previousToken = token.token;
    return cached.token;
  };
}
