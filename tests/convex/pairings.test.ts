import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/pairings.ts": () => import("../../convex/pairings.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/httpBody.ts": () => import("../../convex/httpBody.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
beforeEach(() => vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test"));
afterEach(() => vi.unstubAllEnvs());
const secret = "a".repeat(43);
const input = () => ({
  requestDigest: createHash("sha256").update(secret).digest("hex"),
  credentialDigest: "b".repeat(64),
  localId: "local",
  name: "Test Mac",
  expiresAt: Date.now() + 300000,
});
const identity = {
  issuer: "https://clerk.test",
  subject: "owner",
  tokenIdentifier: "https://clerk.test|owner",
};

test("only an authenticated human can approve and retries cannot rebind the credential", async () => {
  const t = convexTest(schema, modules);
  const request = input();
  await expect(t.mutation(api.pairings.approve, request)).rejects.toThrow();
  const owner = t.withIdentity(identity);
  const first = await owner.mutation(api.pairings.approve, request);
  expect(await owner.mutation(api.pairings.approve, request)).toEqual(first);
  await expect(
    owner.mutation(api.pairings.approve, { ...request, credentialDigest: "c".repeat(64) }),
  ).rejects.toThrow();
  await expect(
    t
      .withIdentity({
        ...identity,
        subject: "stranger",
        tokenIdentifier: "https://clerk.test|stranger",
      })
      .mutation(api.pairings.approve, request),
  ).rejects.toThrow();
  expect(await owner.query(api.machines.list, {})).toHaveLength(1);
});

test("polling requires the local secret and revocation invalidates a successful pairing", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const { machineId } = await owner.mutation(api.pairings.approve, input());
  const poll = (value: string) =>
    t.fetch("/machine/pairing", { method: "POST", body: JSON.stringify({ secret: value }) });
  expect(await (await poll("z".repeat(43))).json()).toEqual({ state: "pending" });
  expect(await (await poll(secret)).json()).toEqual({ machineId, localId: "local" });
  await owner.mutation(api.machines.revoke, { id: machineId });
  expect(await (await poll(secret)).json()).toEqual({ state: "pending" });
});

test("expired requests and attempts to replace a linked machine fail without issuing another credential", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  await expect(
    owner.mutation(api.pairings.approve, { ...input(), expiresAt: Date.now() - 1 }),
  ).rejects.toThrow();
  await owner.mutation(api.pairings.approve, input());
  await expect(
    owner.mutation(api.pairings.approve, { ...input(), requestDigest: "d".repeat(64) }),
  ).rejects.toThrow();
  const records = await t.run(async (ctx) => ctx.db.query("machineCredentials").collect());
  expect(records).toHaveLength(1);
  expect(records[0]?.digest).toBe("b".repeat(64));
});
