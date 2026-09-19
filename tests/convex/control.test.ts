import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { cancelForOwner } from "../../convex/operations.js";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../../apps/server/src/http.js";
import { VectisClient } from "../../packages/client/src/index.js";
import {
  advanceRemoteOperation,
  type Acknowledgement,
} from "../../packages/client/src/remote-operation.js";

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
  await owner.mutation(api.machines.remove, { id });
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
  await owner.mutation(api.machines.remove, { id: machineId });
  expect((await exchange()).status).toBe(401);
});

test("lost local replies and relay restart reuse the durable local operation", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("relay-owner"));
  const home = await mkdtemp(join(tmpdir(), "vectis-relay-"));
  const server = await startService({ home });
  try {
    const local = new VectisClient(server.connection);
    const machineId = await owner.mutation(api.machines.enroll, {
      localId: (await local.status()).machine.id,
      name: "Relay test",
    });
    const device = t.withIdentity({
      issuer: "https://machines.test",
      subject: machineId,
      credentialVersion: 0,
    });
    const id = await owner.mutation(api.operations.submit, {
      machineId,
      key: "pause",
      commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
    });
    const pending = async () => {
      const [operation] = await device.query(api.operations.pending, {});
      if (!operation) throw new Error("Expected pending operation.");
      return operation;
    };
    const acknowledge = (args: Acknowledgement) =>
      device.mutation(api.operations.acknowledge, args);
    const signal = new AbortController().signal;
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    expect((await owner.query(api.operations.get, { id })).phase).toBe("claimed");
    await expect(
      advanceRemoteOperation(
        await pending(),
        {
          status: (...args) => local.status(...args),
          submit: async (...args) => {
            await local.submit(...args);
            throw new Error("Connection lost after the service accepted the command.");
          },
        },
        acknowledge,
        signal,
      ),
    ).rejects.toThrow("Connection lost");
    expect((await owner.query(api.operations.get, { id })).phase).toBe("claimed");
    await server.service.drain();
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    expect((await owner.query(api.operations.get, { id })).phase).toBe("running");
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    const result = await owner.query(api.operations.get, { id });
    expect(result.phase).toBe("succeeded");
    expect((await local.status()).operations).toHaveLength(1);
    expect((await local.status()).machine.paused).toBe(true);
    expect(await device.query(api.operations.pending, {})).toEqual([]);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("machine inventory is bounded, owner-only and rejects revoked credentials", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const stranger = t.withIdentity(identity("stranger"));
  const id = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({
    issuer: "https://machines.test",
    subject: id,
    credentialVersion: 0,
  });
  const environment = {
    id: "mac",
    name: "Mac",
    os: "macos" as const,
    cpu: 4,
    memoryMiB: 8192,
    state: "ready" as const,
  };
  await device.mutation(api.machines.heartbeat, { environments: [environment] });
  expect((await owner.query(api.machines.list, {}))[0]?.environments).toEqual([environment]);
  expect(await stranger.query(api.machines.list, {})).toEqual([]);
  await expect(owner.mutation(api.machines.heartbeat, { environments: [] })).rejects.toThrow();
  await expect(
    device.mutation(api.machines.heartbeat, { environments: [environment, environment] }),
  ).rejects.toThrow();
  await expect(
    device.mutation(api.machines.heartbeat, { environments: [{ ...environment, cpu: -1 }] }),
  ).rejects.toThrow();
  await expect(
    device.mutation(api.machines.heartbeat, {
      environments: Array.from({ length: 101 }, (_, index) => ({
        ...environment,
        id: `vm${index}`,
      })),
    }),
  ).rejects.toThrow();
  await device.mutation(api.machines.heartbeat, { environments: [] });
  expect((await owner.query(api.machines.list, {}))[0]?.environments).toEqual([]);
  await owner.mutation(api.machines.remove, { id });
  await expect(
    device.mutation(api.machines.heartbeat, { environments: [environment] }),
  ).rejects.toThrow();
});

test.each([false, true])(
  "cancellation after claim preserves whether a local effect already completed: %s",
  async (completedLocally) => {
    const t = convexTest(schema, modules);
    const principal = identity("cancel-owner");
    const owner = t.withIdentity(principal);
    const home = await mkdtemp(join(tmpdir(), "vectis-cancel-relay-"));
    const server = await startService({ home });
    try {
      const local = new VectisClient(server.connection);
      const machineId = await owner.mutation(api.machines.enroll, {
        localId: (await local.status()).machine.id,
        name: "Cancel test",
      });
      const device = t.withIdentity({
        issuer: "https://machines.test",
        subject: machineId,
        credentialVersion: 0,
      });
      const command = { type: "machine.pause", paused: true } as const;
      const id = await owner.mutation(api.operations.submit, {
        machineId,
        key: "cancel-test",
        commandJson: JSON.stringify(command),
      });
      const pending = async () => {
        const [operation] = await device.query(api.operations.pending, {});
        if (!operation) throw new Error("Expected pending operation");
        return operation;
      };
      const acknowledge = (args: Acknowledgement) =>
        device.mutation(api.operations.acknowledge, args);
      const signal = new AbortController().signal;
      await advanceRemoteOperation(await pending(), local, acknowledge, signal);
      if (completedLocally) await local.wait((await local.submit(command, `remote:${id}`)).id);
      await t.run((ctx) => cancelForOwner(ctx, principal.tokenIdentifier, id));
      await advanceRemoteOperation(await pending(), local, acknowledge, signal);
      if (completedLocally)
        await advanceRemoteOperation(await pending(), local, acknowledge, signal);
      expect((await owner.query(api.operations.get, { id })).phase).toBe(
        completedLocally ? "succeeded" : "cancelled",
      );
      expect((await local.status()).machine.paused).toBe(completedLocally);
      expect((await local.status()).operations).toHaveLength(completedLocally ? 1 : 0);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
