import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
import { Schema } from "effect";
import { Identifier } from "../../packages/protocol/src/index.js";

const modules = {
  "../../convex/controllers.ts": () => import("../../convex/controllers.js"),
  "../../convex/inspections.ts": () => import("../../convex/inspections.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/operations.ts": () => import("../../convex/operations.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test");
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
});
afterEach(() => vi.unstubAllEnvs());
const identity = (name: string) => ({
  issuer: "https://clerk.test",
  subject: name,
  tokenIdentifier: `https://clerk.test|${name}`,
});
const digest = createHash("sha256").update("isolated credential").digest("hex");

test("remote inspections require an online owned host, bounded responses and an unexpired request", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const controllerId = await owner.mutation(api.controllers.approve, {
    name: "Test",
    requestDigest: "a".repeat(64),
    credentialDigest: digest,
    expiresAt: Date.now() + 300000,
  });
  const machineId = await owner.mutation(api.machines.enroll, { localId: "own", name: "Own" });
  const otherId = await t
    .withIdentity(identity("other"))
    .mutation(api.machines.enroll, { localId: "other", name: "Other" });
  const host = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const otherHost = t.withIdentity({
    issuer: "https://machine.test",
    subject: otherId,
    credentialVersion: 0,
  });
  const call = (request: unknown) =>
    t.mutation(internal.controllers.execute, {
      controllerId,
      digest,
      requestJson: JSON.stringify(request),
    });
  const request = { type: "query.submit", machineId, key: "stable", query: { name: "status" } };
  await expect(call(request)).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch("machines", machineId, { lastSeenAt: Date.now() }));
  const first = Schema.decodeUnknownSync(Schema.Struct({ queryId: Identifier }))(
    await call(request),
  );
  expect(await call(request)).toEqual(first);
  await expect(call({ ...request, machineId: otherId })).rejects.toThrow();
  const [pending] = await host.query(api.inspections.pending, {});
  if (!pending) throw new Error("Expected inspection");
  expect(await otherHost.query(api.inspections.pending, {})).toEqual([]);
  await expect(
    otherHost.mutation(api.inspections.respond, { id: pending.id, responseJson: "{}" }),
  ).rejects.toThrow();
  await expect(
    host.mutation(api.inspections.respond, { id: pending.id, responseJson: "x".repeat(262145) }),
  ).rejects.toThrow();
  await host.mutation(api.inspections.respond, {
    id: pending.id,
    responseJson: '{"ok":true,"result":{}}',
  });
  expect(await call({ type: "query.get", id: first.queryId })).toMatchObject({
    pending: false,
    responseJson: '{"ok":true,"result":{}}',
  });
  expect(await host.query(api.inspections.pending, {})).toEqual([]);
  await t.run((ctx) => ctx.db.patch("inspections", pending.id, { expiresAt: Date.now() - 1 }));
  await expect(call({ type: "query.get", id: first.queryId })).rejects.toThrow();
  await t.mutation(internal.inspections.expire, { id: pending.id });
  expect(await t.run((ctx) => ctx.db.get("inspections", pending.id))).toBeNull();
});
