import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { cancelForOwner } from "../../convex/operations.js";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
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
  "../../convex/runnerDemand.ts": () => import("../../convex/runnerDemand.js"),
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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
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

test("machine tokens issued in the same second have unique signed JWT IDs", async () => {
  vi.useFakeTimers();
  const now = Math.floor(Date.now() / 1000);
  vi.setSystemTime(now * 1000);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv(
    "VECTIS_MACHINE_PRIVATE_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const issue = () =>
    t.action(internal.machineTokens.signToken, { machineId, credentialVersion: 1 });
  const first = await issue();
  const second = await issue();
  expect(second.token).not.toBe(first.token);
  const claims = [first, second].map(({ token, expiresAt }) => {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("Invalid token shape.");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        createPublicKey(privateKey),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(decoded).toMatchObject({
      iss: "https://machines.test",
      aud: "vectis-machine",
      sub: machineId,
      credentialVersion: 1,
      iat: now - 5,
      exp: now + 300,
      jti: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(expiresAt).toBe((now + 300) * 1000);
    if (!decoded || typeof decoded !== "object" || !("jti" in decoded))
      throw new Error("Missing JWT ID.");
    return decoded;
  });
  expect(claims[0]?.jti).not.toBe(claims[1]?.jti);
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
  await device.mutation(api.machines.heartbeat, { environments: [environment], paused: true });
  expect((await owner.query(api.machines.list, {}))[0]).toMatchObject({
    environments: [environment],
    paused: true,
    lastSeenAt: expect.any(Number),
  });
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

test.each([
  {
    type: "repository.access",
    bindingId: "binding",
    actors: { ids: [7, 8] },
    approval: "required",
  },
  { type: "environment.configure", id: "windows", egress: "internet_only" },
  { type: "environment.configure", id: "windows", egress: "open" },
] as const)("$type commands replay locally with the same idempotency key", async (command) => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("access-owner"));
  const machineId = await owner.mutation(api.machines.enroll, {
    localId: "access-host",
    name: "Access host",
  });
  const device = t.withIdentity({
    issuer: "https://machines.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const id = await owner.mutation(api.operations.submit, {
    machineId,
    key: "access",
    commandJson: JSON.stringify(command),
  });
  const acknowledge = (args: Acknowledgement) => device.mutation(api.operations.acknowledge, args);
  const submit = vi.fn(async () => ({
    id: "local-access",
    key: `remote:${id}`,
    status: "succeeded" as const,
    command: command.type,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "Updated",
  }));
  const local = {
    submit,
    status: async () => {
      throw new Error("Unexpected status read");
    },
  };
  const pending = async () => {
    const [operation] = await device.query(api.operations.pending, {});
    if (!operation) throw new Error("Missing remote operation");
    return operation;
  };
  const signal = AbortSignal.timeout(1000);
  await advanceRemoteOperation(await pending(), local, acknowledge, signal);
  expect(submit).not.toHaveBeenCalled();
  await advanceRemoteOperation(await pending(), local, acknowledge, signal);
  expect(submit).toHaveBeenCalledWith(command, `remote:${id}`, signal);
  await advanceRemoteOperation(await pending(), local, acknowledge, signal);
  expect((await owner.query(api.operations.get, { id })).phase).toBe("succeeded");
});

test("a host waking after expiry rejects its stale claim without submitting local work", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("expiry-owner"));
  const home = await mkdtemp(join(tmpdir(), "vectis-expired-relay-"));
  const server = await startService({ home });
  try {
    const local = new VectisClient(server.connection);
    const submit = vi.spyOn(local, "submit");
    const before = await local.status();
    const machineId = await owner.mutation(api.machines.enroll, {
      localId: before.machine.id,
      name: "Expiry test",
    });
    const device = t.withIdentity({
      issuer: "https://machines.test",
      subject: machineId,
      credentialVersion: 0,
    });
    const id = await owner.mutation(api.operations.submit, {
      machineId,
      key: "expired-runner",
      commandJson: JSON.stringify({
        type: "runner.run",
        bindingId: "binding",
        jobId: 4,
        automatic: true,
      }),
    });
    const [stale] = await device.query(api.operations.pending, {});
    if (!stale) throw new Error("Missing pending operation");
    await t.run((ctx) => ctx.db.patch("operations", id, { createdAt: Date.now() - 120000 }));
    await t.mutation(internal.runnerDemand.expireUnclaimed, { operationId: id });
    const expired = await owner.query(api.operations.get, { id });
    expect(expired.phase).toBe("cancelled");
    await expect(
      device.mutation(api.operations.acknowledge, { id, phase: "claimed" }),
    ).rejects.toMatchObject({ data: { code: "operation_cancelled" } });
    const acknowledge = vi.fn((args: Acknowledgement) =>
      device.mutation(api.operations.acknowledge, args),
    );
    const signal = new AbortController().signal;
    await advanceRemoteOperation(stale, local, acknowledge, signal);
    expect(acknowledge).toHaveBeenCalledOnce();
    await advanceRemoteOperation(expired, local, acknowledge, signal);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    const after = await local.status();
    expect(after.operations).toEqual(before.operations);
    expect(after.instances).toEqual(before.instances);
    expect(await device.query(api.operations.pending, {})).toEqual([]);
    expect(await owner.query(api.operations.get, { id })).toEqual(expired);
    const failure = new Error("Cloud unavailable");
    await expect(
      advanceRemoteOperation(
        stale,
        local,
        async () => {
          throw failure;
        },
        signal,
      ),
    ).rejects.toBe(failure);
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
