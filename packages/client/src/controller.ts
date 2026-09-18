import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ControllerRequest } from "../../protocol/src/controller.js";
import { VectisError } from "../../protocol/src/index.js";
import { machineEndpoint } from "./machine-auth.js";
import type { KeychainCredentials } from "./keychain.js";

export const ControllerConnection = Schema.Struct({
  deploymentUrl: Schema.String,
  controllerId: Schema.NonEmptyString,
  expiresAt: Schema.Number,
});
export type ControllerConnection = typeof ControllerConnection.Type;
export const controllerAccount = (connection: ControllerConnection) =>
  `controller:${createHash("sha256")
    .update(JSON.stringify([connection.deploymentUrl, connection.controllerId]))
    .digest("hex")}`;
export const controllerEndpoint = (deploymentUrl: string) =>
  machineEndpoint(deploymentUrl).replace("/machine/token", "/controller/request");

export class ControllerClient {
  constructor(
    readonly connection: ControllerConnection,
    readonly credentials: Pick<KeychainCredentials, "get">,
  ) {
    controllerEndpoint(connection.deploymentUrl);
  }
  async request(
    input: ControllerRequest,
    signal: AbortSignal = AbortSignal.timeout(15000),
  ): Promise<unknown> {
    const request = Schema.decodeUnknownSync(ControllerRequest, { onExcessProperty: "error" })(
      input,
    );
    const secret = await this.credentials.get(controllerAccount(this.connection), signal);
    if (!secret)
      throw new VectisError(
        "controller_secret_missing",
        "The remote-control credential is unavailable.",
        "Unlock Keychain or run vectis login.",
      );
    const response = await fetch(controllerEndpoint(this.connection.deploymentUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.connection.controllerId}.${secret}`,
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (response.status === 401)
      throw new VectisError(
        "controller_unauthorized",
        "Remote access was revoked or expired.",
        "Run vectis logout, then vectis login.",
      );
    if (!response.ok) {
      const issue = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
        await response.json(),
      );
      throw new VectisError(
        issue.code,
        "The remote request could not be completed.",
        "Check the target machine, access and request key before retrying.",
      );
    }
    return response.json();
  }
}
export async function controllerClient(
  home: string,
  credentials: Pick<KeychainCredentials, "get">,
) {
  let content: string;
  try {
    content = await readFile(join(home, "controller.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new VectisError(
        "login_required",
        "This CLI has no remote-control connection.",
        "Run vectis login and approve the request in your browser.",
      );
    throw error;
  }
  return new ControllerClient(
    Schema.decodeUnknownSync(ControllerConnection)(JSON.parse(content)),
    credentials,
  );
}
