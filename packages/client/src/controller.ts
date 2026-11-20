import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ControllerRequest } from "../../protocol/src/controller.js";
import { VectisError } from "../../protocol/src/index.js";
import { CloudErrorBody, ControllerResponses } from "../../protocol/src/cloud.js";
import { validateCloudUrl } from "./deployment.js";
import { buildInfo } from "./build.js";
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
  `${validateCloudUrl(deploymentUrl, buildInfo().flavor)}/controller/request`;

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
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const response = await fetch(controllerEndpoint(this.connection.deploymentUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.connection.controllerId}.${secret}`,
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: requestSignal,
    });
    if (response.status === 401)
      throw new VectisError(
        "controller_unauthorized",
        "Remote access was revoked or expired.",
        "Run vectis logout, then vectis login.",
      );
    const payload: unknown = await response.json().catch(() => undefined);
    requestSignal.throwIfAborted();
    if (response.ok) {
      const result = Schema.decodeUnknownOption(ControllerResponses[request.type])(payload);
      if (result._tag === "Some") return result.value;
    } else {
      const issue = Schema.decodeUnknownOption(CloudErrorBody)(payload);
      if (issue._tag === "Some")
        throw new VectisError(
          issue.value.code,
          "The remote request could not be completed.",
          "Check the target machine, access and request key before retrying.",
        );
    }
    throw new VectisError(
      "controller_invalid_response",
      `The remote-control endpoint returned an invalid or empty response (HTTP ${response.status}).`,
      "Verify the Vectis cloud URL and retry.",
    );
  }
}
export async function controllerClient(
  home: string,
  credentials?: Pick<KeychainCredentials, "get">,
) {
  let content: string;
  try {
    content = await readFile(join(home, "controller.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new VectisError(
        "not_signed_in",
        "This Vectis home has no remote-control login.",
        "Run vectis login, approve the request in your browser, then run vectis login finish. For the local machine, use vectis status in the CLI or vectis_status in a local MCP session.",
      );
    throw error;
  }
  const connection = Schema.decodeUnknownOption(Schema.fromJsonString(ControllerConnection))(
    content,
  );
  if (connection._tag === "None")
    throw new VectisError(
      "controller_config_invalid",
      "The saved remote-control login metadata is invalid or empty.",
      "Move controller.json out of this Vectis home, then run vectis login again.",
    );
  if (!credentials)
    throw new VectisError(
      "setup_required",
      "Remote access requires VECTIS_KEYCHAIN_HELPER.",
      "Configure the native Vectis Keychain helper.",
    );
  return new ControllerClient(connection.value, credentials);
}
