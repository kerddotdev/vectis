import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { PairingDescriptor } from "../../protocol/src/pairing.js";
import { VectisError } from "../../protocol/src/index.js";
import { localClient } from "./local.js";
import {
  CloudConnection,
  credentialAccount,
  machineEndpoint,
  machineTokenFetcher,
} from "./machine-auth.js";
import type { KeychainCredentials } from "./keychain.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const Secrets = Schema.Struct({ request: Schema.String, credential: Schema.String });
const Approved = Schema.Struct({
  machineId: Schema.NonEmptyString,
  localId: Schema.NonEmptyString,
});
type Credentials = Pick<KeychainCredentials, "get" | "set" | "remove">;
const temporaryAccount = (descriptor: PairingDescriptor) => `pairing:${descriptor.requestDigest}`;
async function descriptorAt(home: string) {
  return Schema.decodeUnknownSync(PairingDescriptor, { onExcessProperty: "error" })(
    JSON.parse(await readFile(join(home, "pairing.json"), "utf8")),
  );
}
export async function beginPairing(home: string, deploymentUrl: string, credentials: Credentials) {
  machineEndpoint(deploymentUrl);
  const { machine } = await (await localClient(home)).status();
  try {
    await readFile(join(home, "cloud.json"), "utf8");
    throw new VectisError(
      "connection_exists",
      "This home already has a cloud connection.",
      "Run vectis cloud finish to verify the saved connection.",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let descriptor: PairingDescriptor | undefined;
  try {
    descriptor = await descriptorAt(home);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (
    descriptor &&
    (descriptor.deploymentUrl !== deploymentUrl || descriptor.localId !== machine.id)
  )
    throw new VectisError(
      "pairing_conflict",
      "An existing pairing belongs to another machine or deployment.",
    );
  if (descriptor && descriptor.expiresAt <= Date.now()) {
    await credentials.remove(temporaryAccount(descriptor));
    await rm(join(home, "pairing.json"));
    descriptor = undefined;
  }
  if (!descriptor) {
    const secrets = {
      request: randomBytes(32).toString("base64url"),
      credential: randomBytes(32).toString("base64url"),
    };
    descriptor = {
      deploymentUrl,
      localId: machine.id,
      name: machine.name,
      requestDigest: digest(secrets.request),
      credentialDigest: digest(secrets.credential),
      expiresAt: Date.now() + 600000,
    };
    await credentials.set(temporaryAccount(descriptor), JSON.stringify(secrets));
    try {
      await writeFile(join(home, "pairing.json"), JSON.stringify(descriptor), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await credentials.remove(temporaryAccount(descriptor));
      throw error;
    }
  }
  return {
    state: "action_required",
    verificationCode: descriptor.requestDigest.slice(0, 12).toUpperCase(),
    expiresAt: descriptor.expiresAt,
    url: `https://vectis.kerd.dev/connect#request=${encodeURIComponent(JSON.stringify(Schema.decodeUnknownSync(PairingDescriptor)(descriptor)))}`,
    nextStep:
      "Open this link yourself, compare the verification code and approve. Then run vectis cloud finish. Do not share the pairing link.",
  };
}
export async function finishPairing(
  home: string,
  credentials: Credentials,
  signal: AbortSignal = AbortSignal.timeout(15000),
) {
  let descriptor: PairingDescriptor;
  try {
    descriptor = await descriptorAt(home);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const connection = Schema.decodeUnknownSync(CloudConnection)(
      JSON.parse(await readFile(join(home, "cloud.json"), "utf8")),
    );
    const api = await localClient(home);
    if (
      (await api.status(signal)).machine.id !== connection.localId ||
      !(await machineTokenFetcher(connection, credentials, signal)({ forceRefreshToken: true }))
    )
      throw new VectisError("pairing_revoked", "The saved cloud connection could not be verified.");
    await api.reloadCloud();
    return {
      state: "linked",
      machineId: connection.machineId,
      cloud: (await api.status(signal)).cloud,
    };
  }
  if (descriptor.expiresAt <= Date.now())
    throw new VectisError(
      "pairing_expired",
      "The pairing request expired.",
      "Run vectis cloud pair again.",
    );
  const value = await credentials.get(temporaryAccount(descriptor), signal);
  if (!value)
    throw new VectisError(
      "pairing_secret_missing",
      "The local pairing secret is unavailable.",
      "Unlock the login Keychain and retry.",
    );
  const secrets = Schema.decodeUnknownSync(Secrets)(JSON.parse(value));
  if (
    digest(secrets.request) !== descriptor.requestDigest ||
    digest(secrets.credential) !== descriptor.credentialDigest
  )
    throw new VectisError(
      "pairing_conflict",
      "The pairing file and local credentials do not match.",
    );
  const api = await localClient(home);
  if ((await api.status(signal)).machine.id !== descriptor.localId)
    throw new VectisError("pairing_conflict", "The local machine identity changed.");
  const response = await fetch(
    machineEndpoint(descriptor.deploymentUrl).replace(/\/token$/, "/pairing"),
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
      "Pairing status is unavailable. Retry without creating a new request.",
    );
  const result: unknown = await response.json();
  if (result && typeof result === "object" && "state" in result && result.state === "pending")
    return { state: "pending" };
  const approved = Schema.decodeUnknownSync(Approved)(result);
  if (approved.localId !== descriptor.localId)
    throw new VectisError("pairing_conflict", "The approved machine identity does not match.");
  const connection: CloudConnection = {
    deploymentUrl: descriptor.deploymentUrl,
    machineId: approved.machineId,
    localId: descriptor.localId,
  };
  const config = join(home, "cloud.json");
  try {
    const previous = Schema.decodeUnknownSync(CloudConnection)(
      JSON.parse(await readFile(config, "utf8")),
    );
    if (
      previous.deploymentUrl !== connection.deploymentUrl ||
      previous.machineId !== connection.machineId ||
      previous.localId !== connection.localId
    )
      throw new VectisError(
        "connection_exists",
        "This home already has another cloud connection. It was left unchanged.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await credentials.set(credentialAccount(connection), secrets.credential);
  if (!(await machineTokenFetcher(connection, credentials, signal)({ forceRefreshToken: true })))
    throw new VectisError("pairing_revoked", "The approved credential is no longer valid.");
  const temporary = join(home, `cloud-${randomBytes(8).toString("hex")}.json`);
  await writeFile(temporary, JSON.stringify(connection), { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, config).catch(async (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readFile(config, "utf8");
      if (existing !== JSON.stringify(connection))
        throw new VectisError(
          "connection_exists",
          "A different cloud connection appeared during pairing.",
        );
    });
  } finally {
    await rm(temporary, { force: true });
  }
  await api.reloadCloud();
  await credentials.remove(temporaryAccount(descriptor));
  await rm(join(home, "pairing.json"));
  return {
    state: "linked",
    machineId: approved.machineId,
    cloud: (await api.status(signal)).cloud,
  };
}
