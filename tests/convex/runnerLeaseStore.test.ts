import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
test("durable claims reject conflicting reuse and never expose stored JIT credentials in discovery", async () => {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const { machineId, bindingId, otherBindingId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: Date.now(),
      environments: [
        { id: "mac", name: "Mac", os: "macos", cpu: 2, memoryMiB: 4096, state: "ready" },
      ],
    });
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 71,
      login: "owner",
      installations: [],
      verifiedAt: Date.now(),
    });
    const base = {
      owner: "owner",
      machineId,
      accountId,
      repositoryId: 600,
      repositoryName: "sandbox",
      installationId: 81,
      environmentId: "mac",
      enabled: true,
      verifiedAt: Date.now(),
    };
    const bindingId = await ctx.db.insert("repositoryBindings", base);
    const otherBindingId = await ctx.db.insert("repositoryBindings", {
      ...base,
      repositoryId: 601,
    });
    return { machineId, bindingId, otherBindingId };
  });
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const args = { bindingId, key: "same-command" };
  const first = await device.mutation(internal.runnerLeases.claim, args);
  expect(first.fresh).toBe(true);
  const repeated = await device.mutation(internal.runnerLeases.claim, args);
  expect(repeated.fresh).toBe(false);
  expect(repeated.lease._id).toBe(first.lease._id);
  await expect(
    device.mutation(internal.runnerLeases.claim, { ...args, bindingId: otherBindingId }),
  ).rejects.toThrow();
  await device.mutation(internal.runnerLeases.ready, {
    id: first.lease._id,
    runnerId: 501,
    encodedConfig: "c2VjcmV0",
  });
  const listed = await device.query(api.runnerLeases.list, {});
  expect(listed).toHaveLength(1);
  expect(listed[0]?.phase).toBe("ready");
  expect(JSON.stringify(listed)).not.toContain("c2VjcmV0");
  await device.mutation(internal.runnerLeases.released, { id: first.lease._id });
  expect((await device.mutation(internal.runnerLeases.claim, args)).lease.phase).toBe("released");
  const stored = await t.run((ctx) => ctx.db.get("runnerLeases", first.lease._id));
  expect(stored?.encodedConfig).toBeUndefined();
  expect(stored?.configExpiresAt).toBeUndefined();
});

test("stored runner configurations are deleted when their lifetime ends", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const { machineId, bindingId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: Date.now(),
      environments: [
        { id: "mac", name: "Mac", os: "macos", cpu: 2, memoryMiB: 4096, state: "ready" },
      ],
    });
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 71,
      login: "owner",
      installations: [],
      verifiedAt: Date.now(),
    });
    const bindingId = await ctx.db.insert("repositoryBindings", {
      owner: "owner",
      machineId,
      accountId,
      repositoryId: 600,
      repositoryName: "sandbox",
      installationId: 81,
      environmentId: "mac",
      enabled: true,
      verifiedAt: Date.now(),
    });
    return { machineId, bindingId };
  });
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const { lease } = await device.mutation(internal.runnerLeases.claim, { bindingId, key: "k" });
  await device.mutation(internal.runnerLeases.ready, {
    id: lease._id,
    runnerId: 501,
    encodedConfig: "c2VjcmV0",
  });
  vi.advanceTimersByTime(15 * 60 * 1000);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const stored = await t.run((ctx) => ctx.db.get("runnerLeases", lease._id));
  expect(stored?.phase).toBe("ready");
  expect(stored?.encodedConfig).toBeUndefined();
  expect(stored?.configExpiresAt).toBeUndefined();
});
