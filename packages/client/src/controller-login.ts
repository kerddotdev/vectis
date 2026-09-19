import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ControllerApproval } from "../../protocol/src/controller.js";
import { VectisError } from "../../protocol/src/index.js";
import {
  ControllerClient,
  ControllerConnection,
  controllerAccount,
  controllerClient,
  controllerEndpoint,
} from "./controller.js";
import type { KeychainCredentials } from "./keychain.js";
import type { CloudDeployment } from "./deployment.js";

type Credentials = Pick<KeychainCredentials, "get" | "set" | "remove">;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const temporaryAccount = (request: ControllerApproval) =>
  `controller-pending:${request.requestDigest}`;
const Secrets = Schema.Struct({ request: Schema.String, credential: Schema.String });
async function pending(home: string) {
  return Schema.decodeUnknownSync(ControllerApproval, { onExcessProperty: "error" })(
    JSON.parse(await readFile(join(home, "controller-pending.json"), "utf8")),
  );
}
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
export async function beginControllerLogin(
  home: string,
  deployment: CloudDeployment,
  name: string,
  credentials: Credentials,
) {
  const deploymentUrl = deployment.convexUrl;
  controllerEndpoint(deploymentUrl);
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await readFile(join(home, "controller.json"));
    throw new VectisError(
      "connection_exists",
      "This CLI already has a remote connection.",
      "Use vectis machine list, or vectis logout before changing accounts.",
    );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let request: ControllerApproval | undefined;
  try {
    request = await pending(home);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (request && request.deploymentUrl !== deploymentUrl)
    throw new VectisError("login_conflict", "The pending login belongs to another deployment.");
  if (request && request.expiresAt <= Date.now()) {
    await credentials.remove(temporaryAccount(request));
    await rm(join(home, "controller-pending.json"));
    request = undefined;
  }
  if (!request) {
    const secrets = {
      request: randomBytes(32).toString("base64url"),
      credential: randomBytes(32).toString("base64url"),
    };
    request = Schema.decodeUnknownSync(ControllerApproval)({
      deploymentUrl,
      name,
      requestDigest: hash(secrets.request),
      credentialDigest: hash(secrets.credential),
      expiresAt: Date.now() + 600000,
    });
    await credentials.set(temporaryAccount(request), JSON.stringify(secrets));
    try {
      await writeFile(join(home, "controller-pending.json"), JSON.stringify(request), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await credentials.remove(temporaryAccount(request));
      throw error;
    }
  }
  return {
    state: "action_required",
    verificationCode: request.requestDigest.slice(0, 12).toUpperCase(),
    expiresAt: request.expiresAt,
    url: `${deployment.webUrl}/connect#controller=${encodeURIComponent(JSON.stringify(request))}`,
    nextStep:
      "Open this link yourself, compare the code and approve remote control. Then run vectis login finish. Do not share the login link.",
  };
}
export async function finishControllerLogin(
  home: string,
  credentials: Credentials,
  signal: AbortSignal = AbortSignal.timeout(15000),
) {
  let request: ControllerApproval;
  try {
    request = await pending(home);
  } catch (error) {
    if (!missing(error)) throw error;
    const client = await controllerClient(home, credentials);
    await client.request({ type: "machines.list" }, signal);
    return { state: "linked", controllerId: client.connection.controllerId };
  }
  if (request.expiresAt <= Date.now())
    throw new VectisError(
      "login_expired",
      "This login request expired.",
      "Run vectis login again.",
    );
  const encoded = await credentials.get(temporaryAccount(request), signal);
  if (!encoded)
    throw new VectisError("login_secret_missing", "Unlock Keychain to complete this login.");
  const secrets = Schema.decodeUnknownSync(Secrets)(JSON.parse(encoded));
  if (
    hash(secrets.request) !== request.requestDigest ||
    hash(secrets.credential) !== request.credentialDigest
  )
    throw new VectisError(
      "login_conflict",
      "The login request and local credentials do not match.",
    );
  const response = await fetch(
    controllerEndpoint(request.deploymentUrl).replace(/\/request$/, "/pairing"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: secrets.request }),
      redirect: "error",
      signal,
    },
  );
  if (!response.ok)
    throw new VectisError(
      "cloud_unavailable",
      "Cannot check login approval. Retry the same request.",
    );
  const value: unknown = await response.json();
  if (Schema.is(Schema.Struct({ state: Schema.Literal("pending") }))(value))
    return { state: "pending" };
  const approved = Schema.decodeUnknownSync(
    Schema.Struct({ controllerId: Schema.NonEmptyString, expiresAt: Schema.Number }),
  )(value);
  const connection: ControllerConnection = { ...approved, deploymentUrl: request.deploymentUrl };
  await credentials.set(controllerAccount(connection), secrets.credential);
  await new ControllerClient(connection, credentials).request({ type: "machines.list" }, signal);
  const contents = JSON.stringify(connection);
  const config = join(home, "controller.json");
  const temporary = join(home, `controller-${randomBytes(8).toString("hex")}.json`);
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, config).catch(async (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if ((await readFile(config, "utf8")) !== contents)
        throw new VectisError(
          "connection_exists",
          "A different controller connection already exists.",
        );
    });
  } finally {
    await rm(temporary, { force: true });
  }
  await credentials.remove(temporaryAccount(request));
  await rm(join(home, "controller-pending.json"));
  return { state: "linked", controllerId: approved.controllerId };
}
export async function logoutController(home: string, credentials: Credentials) {
  const client = await controllerClient(home, credentials);
  await client.request({ type: "controller.revoke" }).catch((error: unknown) => {
    if (!(error instanceof VectisError && error.code === "controller_unauthorized")) throw error;
  });
  await credentials.remove(controllerAccount(client.connection));
  await rm(join(home, "controller.json"));
  return { state: "signed_out" };
}
