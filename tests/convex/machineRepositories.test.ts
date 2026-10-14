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
  let installed = true;
  let repositoryPrivate = true;
  let ownerType = "User";
  let ownerId = 7;
  let permission = "admin";
  let permissionUserId = 7;
  let approvalPolicy = "first_time_contributors";
  let beforeRepository: (() => Promise<void>) | undefined;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/installation") && !installed) return new Response(null, { status: 404 });
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
    setInstalled: (value: boolean) => {
      installed = value;
    },
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

test("readiness verifies a ready binding without saving bindings or requesting write tokens", async () => {
  const { device, accountId, t, fetch } = await fixture();
  const bindingId = await device.action(api.githubRepositories.connectMachine, {
    accountId,
    repositoryName: "sandbox",
    environmentId: "windows",
  });
  await device.mutation(api.repositoryBindings.setAutomatic, { bindingId, enabled: true });
  const before = await t.run((ctx) => ctx.db.query("repositoryBindings").collect());
  fetch.mockClear();
  const report = await device.action(api.githubRepositories.readiness, { input: { bindingId } });
  expect(report.environmentId).toBe("windows");
  expect(report.checks.every((check) => check.status === "ok")).toBe(true);
  const named = await device.action(api.githubRepositories.readiness, {
    input: { repositoryName: "owner/sandbox" },
  });
  expect(named).toEqual(report);
  expect(await t.run((ctx) => ctx.db.query("repositoryBindings").collect())).toEqual(before);
  for (const [, init] of fetch.mock.calls) {
    if (init?.body)
      expect(JSON.parse(String(init.body)).permissions).toEqual({
        administration: "read",
        metadata: "read",
      });
  }
});

test.each([
  "github_app_not_installed",
  "repository_admin_required",
  "public_runner_approval_required",
])("readiness and connect report the same %s refusal", async (code) => {
  const { device, accountId, setInstalled, setOrganization, setPublicPolicy, t } = await fixture();
  if (code === "github_app_not_installed") setInstalled(false);
  if (code === "repository_admin_required") setOrganization("write");
  if (code === "public_runner_approval_required") setPublicPolicy("first_time_contributors");
  const report = await device.action(api.githubRepositories.readiness, {
    input: { repositoryName: "owner/sandbox", environmentId: "windows" },
  });
  expect(report.checks).toContainEqual(
    expect.objectContaining({ status: "blocked", code, nextStep: expect.any(String) }),
  );
  await expect(
    device.action(api.githubRepositories.connectMachine, {
      accountId,
      repositoryName: "sandbox",
      environmentId: "windows",
    }),
  ).rejects.toThrow(code);
  expect(await t.run((ctx) => ctx.db.query("repositoryBindings").collect())).toEqual([]);
  if (code === "github_app_not_installed")
    expect(
      report.checks.filter((check) => check.status === "unknown").map((check) => check.id),
    ).toEqual(["github.admin", "github.approval"]);
});

test("an admin refusal does not prevent reading an independent public approval policy", async () => {
  const { device, setOrganization, setPublicPolicy } = await fixture();
  setOrganization("write");
  setPublicPolicy("first_time_contributors");
  const report = await device.action(api.githubRepositories.readiness, {
    input: { repositoryName: "test-org/sandbox", environmentId: "windows" },
  });
  expect(
    report.checks.filter((check) => check.status === "blocked").map((check) => check.code),
  ).toEqual(["repository_admin_required", "public_runner_approval_required"]);
  expect(report.checks.at(-1)).toMatchObject({ status: "attention", code: "binding_missing" });
});

test("readiness rejects another owner's binding before making any GitHub request", async () => {
  const { device, t, machineId, foreignId, fetch } = await fixture();
  const bindingId = await t.run((ctx) =>
    ctx.db.insert("repositoryBindings", {
      owner: "stranger",
      machineId,
      accountId: foreignId,
      repositoryId: 2,
      repositoryName: "secret",
      installationId: 3,
      environmentId: "windows",
      enabled: true,
      verifiedAt: 1,
    }),
  );
  await expect(
    device.action(api.githubRepositories.readiness, { input: { bindingId } }),
  ).rejects.toThrow("repository_access_denied");
  expect(fetch).not.toHaveBeenCalled();
});

test("readiness reports missing identity and changed installations without writing state", async () => {
  const { device, t, accountId, fetch } = await fixture();
  const bindingId = await device.action(api.githubRepositories.connectMachine, {
    accountId,
    repositoryName: "sandbox",
    environmentId: "windows",
  });
  await t.run((ctx) => ctx.db.patch("repositoryBindings", bindingId, { installationId: 4 }));
  expect(
    (await device.action(api.githubRepositories.readiness, { input: { bindingId } })).checks,
  ).toContainEqual(expect.objectContaining({ code: "installation_changed", status: "blocked" }));
  await t.run((ctx) => ctx.db.delete("githubAccounts", accountId));
  fetch.mockClear();
  expect(
    (await device.action(api.githubRepositories.readiness, { input: { bindingId } })).checks[0],
  ).toMatchObject({ code: "github_account_missing", status: "blocked" });
  expect(
    (
      await device.action(api.githubRepositories.readiness, {
        input: { repositoryName: "owner/sandbox" },
      })
    ).checks[0],
  ).toMatchObject({ status: "blocked", code: "github_account_missing" });
  expect(fetch).not.toHaveBeenCalled();
});

test("revocation and account unlinking during GitHub reads cannot produce ready checks", async () => {
  const { device, t, machineId, accountId, setBeforeRepository } = await fixture();
  setBeforeRepository(async () => {
    await t.run((ctx) => ctx.db.patch("machines", machineId, { credentialVersion: 1 }));
  });
  await expect(
    device.action(api.githubRepositories.readiness, { input: { repositoryName: "owner/sandbox" } }),
  ).rejects.toThrow("machine_revoked");
  await t.run((ctx) => ctx.db.patch("machines", machineId, { credentialVersion: 0 }));
  setBeforeRepository(async () => {
    await t.run((ctx) => ctx.db.delete("githubAccounts", accountId));
  });
  const changed = await device.action(api.githubRepositories.readiness, {
    input: { repositoryName: "owner/sandbox" },
  });
  expect(
    changed.checks.every(
      (check) => check.status === "unknown" && check.code === "readiness_changed",
    ),
  ).toBe(true);
});
