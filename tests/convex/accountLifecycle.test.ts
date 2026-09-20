import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/account.ts": () => import("../../convex/account.js"),
  "../../convex/clerkWebhook.ts": () => import("../../convex/clerkWebhook.js"),
  "../../convex/githubIdentity.ts": () => import("../../convex/githubIdentity.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/httpBody.ts": () => import("../../convex/httpBody.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/pairings.ts": () => import("../../convex/pairings.js"),
  "../../convex/purge.ts": () => import("../../convex/purge.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
beforeEach(() => vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test"));
afterEach(() => vi.unstubAllEnvs());
const identity = {
  issuer: "https://clerk.test",
  subject: "owner",
  tokenIdentifier: "https://clerk.test|owner",
};
const secret = "a".repeat(43);
const pairing = () => ({
  requestDigest: createHash("sha256").update(secret).digest("hex"),
  credentialDigest: "b".repeat(64),
  localId: "local",
  name: "Test Mac",
  expiresAt: Date.now() + 300000,
});

async function connected(t: ReturnType<typeof convexTest>, machineId: string) {
  return t.run(async (ctx) => {
    const id = ctx.db.normalizeId("machines", machineId);
    if (!id) throw new Error("Unknown machine");
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "https://clerk.test|owner",
      githubId: 7,
      login: "owner",
      installations: [],
      verifiedAt: 1,
    });
    const bindingId = await ctx.db.insert("repositoryBindings", {
      owner: "https://clerk.test|owner",
      accountId,
      machineId: id,
      repositoryId: 2,
      repositoryName: "sandbox",
      installationId: 3,
      environmentId: "ubuntu",
      enabled: true,
      verifiedAt: 1,
    });
    const operationId = await ctx.db.insert("operations", {
      owner: "https://clerk.test|owner",
      machineId: id,
      key: "run",
      commandJson: "{}",
      phase: "accepted",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("runnerLeases", {
      owner: "https://clerk.test|owner",
      machineId: id,
      bindingId,
      environmentId: "ubuntu",
      os: "linux",
      key: "run",
      phase: "ready",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("runnerDemands", {
      installationId: 3,
      repositoryId: 2,
      jobId: 4,
      owner: "https://clerk.test|owner",
      bindingId,
      operationId,
      attempt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("inspections", {
      owner: "https://clerk.test|owner",
      machineId: id,
      key: "status",
      queryJson: "{}",
      expiresAt: Date.now() + 60000,
      pending: true,
    });
    await ctx.db.insert("migrationPreviews", {
      owner: "https://clerk.test|owner",
      machineId: id,
      bindingId,
      reportJson: "{}",
      createdAt: 1,
      expiresAt: Date.now() + 86400000,
    });
    return { bindingId };
  });
}

const counts = async (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ({
    machines: (await ctx.db.query("machines").collect()).length,
    credentials: (await ctx.db.query("machineCredentials").collect()).length,
    pairings: (await ctx.db.query("pairings").collect()).length,
    bindings: (await ctx.db.query("repositoryBindings").collect()).length,
    leases: (await ctx.db.query("runnerLeases").collect()).length,
    demands: (await ctx.db.query("runnerDemands").collect()).length,
    operations: (await ctx.db.query("operations").collect()).length,
    inspections: (await ctx.db.query("inspections").collect()).length,
    previews: (await ctx.db.query("migrationPreviews").collect()).length,
  }));

test("removing a machine deletes everything it owns and frees the local identity", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const { machineId } = await owner.mutation(api.pairings.approve, pairing());
  await connected(t, machineId);
  expect(await counts(t)).toMatchObject({ machines: 1, bindings: 1, leases: 1, demands: 1 });
  await expect(
    t
      .withIdentity({ ...identity, subject: "other", tokenIdentifier: "https://clerk.test|other" })
      .mutation(api.machines.remove, { id: machineId }),
  ).rejects.toThrow();
  await owner.mutation(api.machines.remove, { id: machineId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts(t)).toEqual({
    machines: 0,
    credentials: 0,
    pairings: 0,
    bindings: 0,
    leases: 0,
    demands: 0,
    operations: 0,
    inspections: 0,
    previews: 0,
  });
  const again = await owner.mutation(api.pairings.approve, pairing());
  expect(again.machineId).not.toBe(machineId);
  expect(await owner.query(api.machines.list, {})).toHaveLength(1);
  vi.useRealTimers();
});

test("unlinking a GitHub account disconnects the repositories that depend on it", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const { machineId } = await owner.mutation(api.pairings.approve, pairing());
  await connected(t, machineId);
  const account = (await owner.query(api.githubIdentity.list, {})).accounts[0];
  if (!account) throw new Error("Missing linked account");
  await expect(
    t
      .withIdentity({ ...identity, subject: "other", tokenIdentifier: "https://clerk.test|other" })
      .mutation(api.githubIdentity.unlink, { id: account.id }),
  ).rejects.toThrow();
  await owner.mutation(api.githubIdentity.unlink, { id: account.id });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts(t)).toMatchObject({ machines: 1, bindings: 0, leases: 0, demands: 0 });
  expect((await owner.query(api.githubIdentity.list, {})).accounts).toHaveLength(0);
  vi.useRealTimers();
});

const empty = {
  machines: 0,
  credentials: 0,
  pairings: 0,
  bindings: 0,
  leases: 0,
  demands: 0,
  operations: 0,
  inspections: 0,
  previews: 0,
};

test("deleting an account removes everything it owns", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const { machineId } = await owner.mutation(api.pairings.approve, pairing());
  await connected(t, machineId);
  await t
    .withIdentity({ ...identity, subject: "other", tokenIdentifier: "https://clerk.test|other" })
    .mutation(api.account.remove, {});
  expect(await counts(t)).toMatchObject({ machines: 1, bindings: 1 });
  await owner.mutation(api.account.remove, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts(t)).toEqual(empty);
  expect(await t.run(async (ctx) => ctx.db.query("githubAccounts").collect())).toHaveLength(0);
  vi.useRealTimers();
});

test("a signed Clerk deletion purges the account and an unsigned one is refused", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CLERK_WEBHOOK_SECRET", `whsec_${btoa("webhook-test-secret")}`);
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const { machineId } = await owner.mutation(api.pairings.approve, pairing());
  await connected(t, machineId);
  const body = JSON.stringify({ type: "user.deleted", data: { id: "owner" } });
  const send = (headers: Record<string, string>) =>
    t.fetch("/clerk/webhook", { method: "POST", body, headers });
  expect((await send({ "svix-id": "msg_1" })).status).toBe(401);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`msg_1.${timestamp}.${body}`),
        ),
      ),
    ),
  );
  expect(
    (
      await send({
        "svix-id": "msg_1",
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${btoa("wrong")}`,
      })
    ).status,
  ).toBe(401);
  expect(await counts(t)).toMatchObject({ machines: 1 });
  const accepted = await send({
    "svix-id": "msg_1",
    "svix-timestamp": timestamp,
    "svix-signature": `v0,ignored v1,${signature}`,
  });
  expect(accepted.status).toBe(202);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await counts(t)).toEqual(empty);
  vi.useRealTimers();
});
