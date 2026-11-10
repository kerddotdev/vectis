// Helpers for tests that run inside workerd (apps/cloud/test and src/**/*.test.ts). Never imported
// by production code.
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";
import type { EnvironmentSummary } from "../../../packages/protocol/src/cloud.js";
import type { RepositoryAccess } from "../../../packages/protocol/src/repository-access.js";
import { newId, sha256Hex } from "./ids.js";

export { env, SELF };

export const now = () => Date.now();

export function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export const readyLinux = (id = "linux"): EnvironmentSummary => ({
  id,
  name: "Ubuntu",
  os: "linux",
  cpu: 4,
  memoryMiB: 8192,
  state: "ready",
});

export async function seedMachine(
  input: {
    owner?: string;
    localId?: string;
    environments?: EnvironmentSummary[];
    paused?: boolean;
  } = {},
) {
  const id = newId();
  const credential = secret();
  const owner = input.owner ?? "https://clerk.invalid|user_1";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO machines (id, owner, localId, name, createdAt, environmentsJson, paused) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      owner,
      input.localId ?? `host-${id.slice(0, 6)}`,
      "Test Mac",
      now(),
      input.environments ? JSON.stringify(input.environments) : null,
      input.paused === undefined ? null : input.paused ? 1 : 0,
    ),
    env.DB.prepare(
      "INSERT INTO machineCredentials (machineId, digest, createdAt) VALUES (?, ?, ?)",
    ).bind(id, await sha256Hex(credential), now()),
  ]);
  return { id, owner, bearer: `${id}.${credential}` };
}

export async function seedApp(webhookSecret = "webhook-secret") {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  await env.DB.prepare(
    "INSERT INTO githubApps (singleton, appId, slug, ownerId, clientId, privateKey, clientSecret, webhookSecret) VALUES (1, 1, 'vectis-test', 1, 'Iv1.test', ?, 'client-secret', ?)",
  )
    .bind(pem, webhookSecret)
    .run();
  return { webhookSecret };
}

export async function seedAccount(
  owner: string,
  input: {
    githubId?: number;
    login?: string;
    installations?: { id: number; accountId: number; login: string }[];
  } = {},
) {
  const id = newId();
  const githubId = input.githubId ?? 100;
  const login = input.login ?? "octo";
  await env.DB.prepare(
    "INSERT INTO githubAccounts (id, owner, githubId, login, installationsJson, verifiedAt) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      owner,
      githubId,
      login,
      JSON.stringify(input.installations ?? [{ id: 10, accountId: githubId, login }]),
      now(),
    )
    .run();
  return { id, githubId, login };
}

export async function seedBinding(input: {
  owner: string;
  accountId: string;
  machineId: string;
  repositoryId?: number;
  repositoryName?: string;
  repositoryOwner?: string;
  installationId?: number;
  environmentId?: string;
  enabled?: boolean;
  automatic?: boolean;
  infraRerun?: boolean;
  capacityMode?: "demand" | "scale_set";
  access?: RepositoryAccess;
  cacheVolume?: { enabled: boolean; sizeGiB: number };
}) {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO repositoryBindings (id, owner, accountId, machineId, repositoryId, repositoryName,
      repositoryOwner, installationId, environmentId, enabled, infraRerun, automatic, capacityMode,
      accessJson, cacheVolumeJson, verifiedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.owner,
      input.accountId,
      input.machineId,
      input.repositoryId ?? 1000,
      input.repositoryName ?? "repo",
      input.repositoryOwner ?? null,
      input.installationId ?? 10,
      input.environmentId ?? "linux",
      input.enabled === false ? 0 : 1,
      input.infraRerun ? 1 : 0,
      input.automatic ? 1 : 0,
      input.capacityMode ?? "demand",
      input.access ? JSON.stringify(input.access) : null,
      input.cacheVolume ? JSON.stringify(input.cacheVolume) : null,
      now(),
    )
    .run();
  return { id };
}

// POSTs a machine API route with the machine's bearer.
export function machineRequest(path: string, bearer: string, body: unknown = {}) {
  return SELF.fetch(`https://cloud.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Signs Clerk-shaped session tokens for env.CLERK_ISSUER and serves the matching JWKS through the
// fetch stub, so human routes can be tested without Clerk.
let signer: Promise<{ key: CryptoKey; jwks: unknown }> | undefined;
async function clerkKeys() {
  signer ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
    return { key: privateKey, jwks: { keys: [jwk] } };
  })();
  return signer;
}
export async function humanToken(subject = "user_1", claims: Record<string, unknown> = {}) {
  const { key } = await clerkKeys();
  return new SignJWT({ azp: env.VECTIS_WEB_URL, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(env.CLERK_ISSUER)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
export const ownerOf = (subject = "user_1") => `${env.CLERK_ISSUER}|${subject}`;

export async function humanRequest(
  path: string,
  body?: unknown,
  subject = "user_1",
): Promise<Response> {
  return SELF.fetch(`https://cloud.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${await humanToken(subject)}`,
      Origin: env.VECTIS_WEB_URL,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Replaces global fetch for the test. Clerk JWKS requests are answered automatically; everything
// else goes to `handler`, and unhandled requests fail the call loudly.
export function stubFetch(
  handler: (request: Request) => Response | Promise<Response> | undefined = () => undefined,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${env.CLERK_ISSUER}/.well-known/jwks.json`)
      return Response.json((await clerkKeys()).jwks);
    const response = await handler(request);
    if (!response) throw new Error(`Unexpected fetch in test: ${request.method} ${request.url}`);
    return response;
  });
}
