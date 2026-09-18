import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/repositoryBindings.ts": () => import("../../convex/repositoryBindings.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const identity = {
  issuer: "https://clerk.test",
  subject: "owner",
  tokenIdentifier: "https://clerk.test|owner",
};
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", identity.issuer);
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
});
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const machineId = await owner.mutation(api.machines.enroll, { localId: "mac", name: "Mac" });
  const accountId = await t.run((ctx) =>
    ctx.db.insert("githubAccounts", {
      owner: identity.tokenIdentifier,
      githubId: 71,
      login: "owner",
      installations: [],
      verifiedAt: Date.now(),
    }),
  );
  return { t, owner, machineId, accountId };
}
test("bindings deduplicate and disappear from machine admission when disabled", async () => {
  const { t, owner, machineId, accountId } = await setup();
  const args = {
    owner: identity.tokenIdentifier,
    machineId,
    accountId,
    repositoryId: 42,
    repositoryName: "sandbox",
    installationId: 81,
    environmentId: "linux",
  };
  const id = await t.mutation(internal.repositoryBindings.save, args);
  expect(await t.mutation(internal.repositoryBindings.save, args)).toBe(id);
  expect(await owner.query(api.repositoryBindings.list, {})).toHaveLength(1);
  const machine = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  expect(await machine.query(api.repositoryBindings.forMachine, {})).toEqual([
    {
      id,
      repositoryId: 42,
      repositoryName: "owner/sandbox",
      environmentId: "linux",
      automatic: false,
    },
  ]);
  await machine.mutation(api.repositoryBindings.setAutomatic, { bindingId: id, enabled: true });
  expect((await machine.query(api.repositoryBindings.forMachine, {}))[0]?.automatic).toBe(true);
  await owner.mutation(api.repositoryBindings.disable, { id });
  await expect(
    machine.mutation(api.repositoryBindings.setAutomatic, { bindingId: id, enabled: true }),
  ).rejects.toThrow();
  expect(await machine.query(api.repositoryBindings.forMachine, {})).toEqual([]);
  await owner.mutation(api.machines.revoke, { id: machineId });
  await expect(t.mutation(internal.repositoryBindings.save, args)).rejects.toThrow();
  await expect(machine.query(api.repositoryBindings.forMachine, {})).rejects.toThrow();
});
test("foreign account and machine ownership are rechecked at persistence", async () => {
  const { t, owner, machineId, accountId } = await setup();
  const stranger = t.withIdentity({
    ...identity,
    subject: "stranger",
    tokenIdentifier: "https://clerk.test|stranger",
  });
  const foreign = await stranger.mutation(api.machines.enroll, { localId: "other", name: "Other" });
  const args = {
    owner: identity.tokenIdentifier,
    machineId: foreign,
    accountId,
    repositoryId: 42,
    repositoryName: "sandbox",
    installationId: 81,
    environmentId: "linux",
  };
  await expect(t.mutation(internal.repositoryBindings.save, args)).rejects.toThrow();
  const id = await t.mutation(internal.repositoryBindings.save, { ...args, machineId });
  expect(await stranger.query(api.repositoryBindings.list, {})).toEqual([]);
  await expect(stranger.mutation(api.repositoryBindings.disable, { id })).rejects.toThrow();
  await t.run((ctx) =>
    ctx.db.patch("githubAccounts", accountId, { owner: "https://clerk.test|stranger" }),
  );
  await expect(
    t.mutation(internal.repositoryBindings.save, { ...args, machineId }),
  ).rejects.toThrow();
  expect(await owner.query(api.repositoryBindings.list, {})).toHaveLength(1);
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  expect(await device.query(api.repositoryBindings.forMachine, {})).toEqual([]);
  await expect(
    device.mutation(api.repositoryBindings.setAutomatic, { bindingId: id, enabled: true }),
  ).rejects.toThrow();
});
