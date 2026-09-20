import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/githubRepositories.ts": () => import("../../convex/githubRepositories.js"),
  "../../convex/repositoryBindings.ts": () => import("../../convex/repositoryBindings.js"),
  "../../convex/githubIdentity.ts": () => import("../../convex/githubIdentity.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const { machineId, accountId, foreignId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: 1,
      environments: [
        { id: "windows", name: "Windows", os: "windows", cpu: 4, memoryMiB: 8192, state: "ready" },
      ],
    });
    const account = {
      owner: "owner",
      githubId: 7,
      login: "owner",
      installations: [],
      verifiedAt: 1,
    };
    const accountId = await ctx.db.insert("githubAccounts", account);
    const foreignId = await ctx.db.insert("githubAccounts", {
      ...account,
      owner: "stranger",
      githubId: 8,
    });
    await ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 7,
      clientId: "client",
      privateKey,
      clientSecret: "test",
      webhookSecret: "test",
    });
    return { machineId, accountId, foreignId };
  });
  let repositoryPrivate = true;
  let ownerType = "User";
  let ownerId = 7;
  let permission = "admin";
  let permissionUserId = 7;
  let approvalPolicy = "first_time_contributors";
  let beforeRepository: (() => Promise<void>) | undefined;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 3,
        app_id: 42,
        account: { id: ownerId, type: ownerType },
        suspended_at: null,
      });
    if (url.endsWith("/permission"))
      return Response.json({ permission, user: { id: permissionUserId } });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "test-token" });
    if (url.endsWith("/fork-pr-contributor-approval"))
      return Response.json({ approval_policy: approvalPolicy });
    await beforeRepository?.();
    return Response.json({ id: 2, private: repositoryPrivate, owner: { id: ownerId } });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    t,
    machineId,
    accountId,
    foreignId,
    fetch,
    setOrganization: (role: string, userId = 7) => {
      ownerType = "Organization";
      ownerId = 99;
      permission = role;
      permissionUserId = userId;
    },
    setPublicPolicy: (policy: string) => {
      repositoryPrivate = false;
      approvalPolicy = policy;
    },
    setBeforeRepository: (callback: () => Promise<void>) => {
      beforeRepository = callback;
    },
    device: t.withIdentity({
      issuer: "https://machine.test",
      subject: machineId,
      credentialVersion: 0,
    }),
  };
}
test("paired machines discover only verified owner accounts and connect one prepared environment", async () => {
  const { device, accountId, foreignId, fetch } = await fixture();
  expect(await device.query(api.githubIdentity.forMachine, {})).toEqual([
    { id: accountId, githubId: 7, login: "owner" },
  ]);
  const args = { accountId, repositoryName: "sandbox", environmentId: "windows" };
  await expect(
    device.action(api.githubRepositories.connectMachine, { ...args, accountId: foreignId }),
  ).rejects.toThrow();
  await expect(
    device.action(api.githubRepositories.connectMachine, { ...args, environmentId: "missing" }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const id = await device.action(api.githubRepositories.connectMachine, args);
  expect(await device.action(api.githubRepositories.connectMachine, args)).toBe(id);
  expect(await device.query(api.repositoryBindings.forMachine, {})).toMatchObject([
    { id, repositoryId: 2, environmentId: "windows", automatic: false },
  ]);
});
test("credential revocation during GitHub verification prevents repository binding", async () => {
  const { device, accountId, machineId, t, setBeforeRepository } = await fixture();
  setBeforeRepository(async () => {
    await t.run(async (ctx) => ctx.db.patch("machines", machineId, { credentialVersion: 1 }));
  });
  await expect(
    device.action(api.githubRepositories.connectMachine, {
      accountId,
      repositoryName: "sandbox",
      environmentId: "windows",
    }),
  ).rejects.toThrow();
  expect(await t.run(async (ctx) => ctx.db.query("repositoryBindings").collect())).toHaveLength(0);
});

test("public connections return an actionable approval error and persist only after policy verification", async () => {
  const { device, accountId, setPublicPolicy, t } = await fixture();
  const input = { accountId, repositoryName: "sandbox", environmentId: "windows" };
  setPublicPolicy("first_time_contributors");
  await expect(device.action(api.githubRepositories.connectMachine, input)).rejects.toThrow(
    "public_runner_approval_required",
  );
  expect(await t.run((ctx) => ctx.db.query("repositoryBindings").collect())).toEqual([]);
  setPublicPolicy("all_external_contributors");
  await expect(device.action(api.githubRepositories.connectMachine, input)).resolves.toEqual(
    expect.any(String),
  );
});

test("organization bindings retain a separate repository owner and reject non-admin identities", async () => {
  const { device, accountId, setOrganization, t } = await fixture();
  const input = {
    accountId,
    repositoryName: "sandbox",
    repositoryOwner: "test-org",
    environmentId: "windows",
  };
  setOrganization("write");
  await expect(device.action(api.githubRepositories.connectMachine, input)).rejects.toThrow(
    "repository_admin_required",
  );
  setOrganization("admin", 8);
  await expect(device.action(api.githubRepositories.connectMachine, input)).rejects.toThrow(
    "repository_admin_required",
  );
  expect(await t.run((ctx) => ctx.db.query("repositoryBindings").collect())).toEqual([]);
  setOrganization("admin");
  const id = await device.action(api.githubRepositories.connectMachine, input);
  expect(await device.query(api.repositoryBindings.forMachine, {})).toMatchObject([
    { id, repositoryName: "test-org/sandbox" },
  ]);
  expect(await t.run((ctx) => ctx.db.get("repositoryBindings", id))).toMatchObject({
    repositoryOwner: "test-org",
    accountId,
  });
});
