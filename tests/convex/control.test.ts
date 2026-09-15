import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/credentials.ts": () => import("../../convex/credentials.js"),
  "../../convex/machineTokens.ts": () => import("../../convex/machineTokens.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/operations.ts": () => import("../../convex/operations.js"),
};
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test");
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machines.test");
});
afterEach(() => vi.unstubAllEnvs());
const identity = (subject: string) => ({
  issuer: "https://clerk.test",
  subject,
  tokenIdentifier: `https://clerk.test|${subject}`,
});

test("owners cannot see or control each other's machines", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const stranger = t.withIdentity(identity("stranger"));
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  expect(await stranger.query(api.machines.list, {})).toEqual([]);
  await expect(
    stranger.mutation(api.operations.submit, {
      machineId,
      key: "foreign",
      commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
    }),
  ).rejects.toThrow();
  await expect(t.query(api.machines.list, {})).rejects.toThrow();
});
test("remote commands deduplicate and enforce distinct acknowledgement phases", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({
    issuer: "https://machines.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const input = {
    machineId,
    key: "pause",
    commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
  };
  const id = await owner.mutation(api.operations.submit, input);
  expect(await owner.mutation(api.operations.submit, input)).toBe(id);
  await expect(
    owner.mutation(api.operations.submit, {
      ...input,
      commandJson: JSON.stringify({ type: "machine.pause", paused: false }),
    }),
  ).rejects.toThrow();
  await expect(
    device.mutation(api.operations.acknowledge, { id, phase: "succeeded" }),
  ).rejects.toThrow();
  for (const phase of ["claimed", "running", "succeeded"] as const)
    await device.mutation(api.operations.acknowledge, { id, phase });
  await device.mutation(api.operations.acknowledge, { id, phase: "succeeded" });
  expect((await owner.query(api.operations.get, { id })).phase).toBe("succeeded");
  expect(await device.query(api.operations.pending, {})).toEqual([]);
});
test("revocation immediately blocks machine access and human credentials cannot impersonate a machine", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const id = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({
    issuer: "https://machines.test",
    subject: id,
    credentialVersion: 0,
  });
  await expect(owner.query(api.operations.pending, {})).rejects.toThrow();
  await device.mutation(api.machines.heartbeat, {});
  await owner.mutation(api.machines.revoke, { id });
  await expect(device.query(api.operations.pending, {})).rejects.toThrow();
});

test("machine secrets are hashed and exchange for short-lived signed JWTs until revocation", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv(
    "VECTIS_MACHINE_PRIVATE_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const machineId = await owner.mutation(api.machines.enroll, {
    localId: "jwt-test",
    name: "JWT test",
  });
  const { secret } = await owner.action(api.machineTokens.issueCredential, { machineId });
  const saved = await t.run((ctx) => ctx.db.query("machineCredentials").collect());
  expect(JSON.stringify(saved).includes(secret)).toBe(false);
  const exchange = () =>
    t.fetch("/machine/token", { method: "POST", body: JSON.stringify({ machineId, secret }) });
  const response = await exchange();
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("token" in result) ||
    typeof result.token !== "string"
  )
    throw new Error("Missing token.");
  const [header, payload, signature] = result.token.split(".");
  if (!header || !payload || !signature) throw new Error("Invalid token shape.");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(privateKey),
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
    sub: machineId,
    aud: "vectis-machine",
    credentialVersion: 1,
  });
  await owner.mutation(api.machines.revoke, { id: machineId });
  expect((await exchange()).status).toBe(401);
});
