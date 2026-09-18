import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/controllers.ts": () => import("../../convex/controllers.js"),
  "../../convex/controllerHttp.ts": () => import("../../convex/controllerHttp.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/operations.ts": () => import("../../convex/operations.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const identity = (name: string) => ({
  issuer: "https://clerk.test",
  subject: name,
  tokenIdentifier: `https://clerk.test|${name}`,
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const requestSecret = "r".repeat(43);
const credential = "s".repeat(43);
const approval = () => ({
  name: "Isolated CLI",
  requestDigest: hash(requestSecret),
  credentialDigest: hash(credential),
  expiresAt: Date.now() + 300000,
});
beforeEach(() => vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test"));
afterEach(() => vi.unstubAllEnvs());

test("controller approval cannot be rebound and never exposes credential digests", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const input = approval();
  await expect(t.mutation(api.controllers.approve, input)).rejects.toThrow();
  const id = await owner.mutation(api.controllers.approve, input);
  expect(await owner.mutation(api.controllers.approve, input)).toBe(id);
  await expect(
    owner.mutation(api.controllers.approve, { ...input, credentialDigest: hash("other") }),
  ).rejects.toThrow();
  await expect(
    t.withIdentity(identity("stranger")).mutation(api.controllers.approve, input),
  ).rejects.toThrow();
  const listed = await owner.query(api.controllers.list, {});
  expect(listed).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(input.credentialDigest);
  expect(JSON.stringify(listed)).not.toContain(credential);
  const poll = await t.fetch("/controller/pairing", {
    method: "POST",
    body: JSON.stringify({ secret: requestSecret }),
  });
  expect(await poll.json()).toMatchObject({ controllerId: id });
  expect(
    await (
      await t.fetch("/controller/pairing", {
        method: "POST",
        body: JSON.stringify({ secret: "z".repeat(43) }),
      })
    ).json(),
  ).toEqual({ state: "pending" });
});

test("controller requests isolate owners, deduplicate commands and honor immediate revocation", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const stranger = t.withIdentity(identity("stranger"));
  const controllerId = await owner.mutation(api.controllers.approve, approval());
  const machineId = await owner.mutation(api.machines.enroll, { localId: "own", name: "Own Mac" });
  const otherMachine = await stranger.mutation(api.machines.enroll, {
    localId: "other",
    name: "Other Mac",
  });
  const call = (request: unknown, secret = credential) =>
    t.fetch("/controller/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${controllerId}.${secret}` },
      body: JSON.stringify(request),
    });
  expect(await (await call({ type: "machines.list" })).json()).toMatchObject([
    { id: machineId, online: false },
  ]);
  const command = {
    type: "operation.submit",
    machineId,
    key: "stable",
    command: { type: "machine.pause", paused: true },
  };
  const first = await (await call(command)).json();
  expect(first).toHaveProperty("operationId");
  expect(await (await call(command)).json()).toEqual(first);
  expect((await call({ ...command, machineId: otherMachine })).status).toBe(409);
  expect(
    (await call({ ...command, command: { type: "machine.pause", paused: false } })).status,
  ).toBe(409);
  expect((await call({ type: "machines.list" }, "x".repeat(43))).status).toBe(401);
  await expect(stranger.mutation(api.controllers.revoke, { id: controllerId })).rejects.toThrow();
  await owner.mutation(api.controllers.revoke, { id: controllerId });
  expect((await call({ type: "machines.list" })).status).toBe(401);
  expect(
    await t.query(internal.controllers.resolve, { requestDigest: hash(requestSecret) }),
  ).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(1);
});

test("expired controllers cannot retain access or reveal another owner's operations", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const controllerId = await owner.mutation(api.controllers.approve, approval());
  const other = t.withIdentity(identity("other"));
  const machineId = await other.mutation(api.machines.enroll, { localId: "other", name: "Other" });
  const id = await other.mutation(api.operations.submit, {
    machineId,
    key: "other",
    commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
  });
  const execute = (request: unknown) =>
    t.mutation(internal.controllers.execute, {
      controllerId,
      digest: hash(credential),
      requestJson: JSON.stringify(request),
    });
  await expect(execute({ type: "operation.get", id })).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch("controllers", controllerId, { expiresAt: Date.now() - 1 }));
  await expect(execute({ type: "machines.list" })).rejects.toThrow();
});

test("cancelling an offline queued command prevents the host from receiving it", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const controllerId = await owner.mutation(api.controllers.approve, approval());
  const machineId = await owner.mutation(api.machines.enroll, {
    localId: "offline",
    name: "Offline",
  });
  const id = await owner.mutation(api.operations.submit, {
    machineId,
    key: "queued",
    commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
  });
  await t.mutation(internal.controllers.execute, {
    controllerId,
    digest: hash(credential),
    requestJson: JSON.stringify({ type: "operation.cancel", id }),
  });
  expect(await owner.query(api.operations.get, { id })).toMatchObject({
    phase: "cancelled",
    cancelRequested: true,
  });
});
