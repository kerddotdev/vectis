import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/migrationPreviews.ts": () => import("../../convex/migrationPreviews.js"),
  "../../convex/githubMigrations.ts": () => import("../../convex/githubMigrations.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const report = {
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  files: [
    {
      path: ".github/workflows/ci.yml",
      mode: "100644",
      before: "jobs: {}\n",
      after: "jobs: {}\n",
      changed: false,
      findings: [],
    },
  ],
};
async function fixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      revoked: false,
      createdAt: 1,
      environments: [
        {
          id: "mac",
          name: "Mac",
          os: "macos",
          cpu: 2,
          memoryMiB: 4096,
          state: "ready",
          revision: "a".repeat(64),
        },
      ],
    });
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 7,
      login: "owner",
      installations: [],
      verifiedAt: 1,
    });
    const bindingId = await ctx.db.insert("repositoryBindings", {
      owner: "owner",
      machineId,
      accountId,
      repositoryId: 2,
      repositoryName: "sandbox",
      installationId: 3,
      environmentId: "mac",
      enabled: true,
      verifiedAt: 1,
    });
    return { machineId, bindingId, accountId };
  });
  return {
    t,
    ...ids,
    device: t.withIdentity({
      issuer: "https://machine.test",
      subject: ids.machineId,
      credentialVersion: 0,
    }),
  };
}
test("migration publication requires a successful job on a cleaned runner from the same binding", async () => {
  const { t, device, machineId, bindingId } = await fixture();
  expect(await device.query(internal.migrationPreviews.verified, { bindingId })).toBe(false);
  const previewId = await device.mutation(internal.migrationPreviews.save, {
    bindingId,
    reportJson: JSON.stringify(report),
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(device.action(api.githubMigrations.publish, { previewId })).rejects.toThrow(
    "environment_not_verified",
  );
  expect(fetch).not.toHaveBeenCalled();
  const leaseId = await t.run(async (ctx) => {
    await ctx.db.insert("githubJobs", {
      installationId: 3,
      repositoryId: 2,
      jobId: 4,
      runId: 5,
      name: "test",
      status: "completed",
      conclusion: "success",
      labels: ["vectis-mac"],
      runnerId: 6,
      runnerName: "runner",
      updatedAt: 1,
    });
    return ctx.db.insert("runnerLeases", {
      owner: "owner",
      machineId,
      bindingId,
      environmentId: "mac",
      os: "macos",
      key: "run",
      phase: "ready",
      environmentRevision: "a".repeat(64),
      runnerId: 6,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  expect(await device.query(internal.migrationPreviews.verified, { bindingId })).toBe(false);
  await t.run(async (ctx) => ctx.db.patch("runnerLeases", leaseId, { phase: "released" }));
  expect(await device.query(internal.migrationPreviews.verified, { bindingId })).toBe(true);
  await t.run(async (ctx) => ctx.db.patch("runnerLeases", leaseId, { runnerId: 99 }));
  expect(await device.query(internal.migrationPreviews.verified, { bindingId })).toBe(false);
});
test("preview reads and writes recheck ownership, expiry and machine revocation", async () => {
  const { t, device, machineId, bindingId } = await fixture();
  const args = { bindingId, reportJson: JSON.stringify(report) };
  const previewId = await device.mutation(internal.migrationPreviews.save, args);
  expect((await device.query(internal.migrationPreviews.owned, { previewId })).bindingId).toBe(
    bindingId,
  );
  await expect(
    t.withIdentity({ subject: "other" }).query(internal.migrationPreviews.owned, { previewId }),
  ).rejects.toThrow();
  await t.run(async (ctx) => ctx.db.patch("migrationPreviews", previewId, { expiresAt: 1 }));
  await expect(device.query(internal.migrationPreviews.owned, { previewId })).rejects.toThrow();
  await t.run(async (ctx) => ctx.db.patch("machines", machineId, { revoked: true }));
  await expect(device.mutation(internal.migrationPreviews.save, args)).rejects.toThrow();
});

test("changing the prepared environment invalidates retained previews", async () => {
  const { t, device, machineId, bindingId } = await fixture();
  const previewId = await device.mutation(internal.migrationPreviews.save, {
    bindingId,
    reportJson: JSON.stringify(report),
  });
  await t.run(async (ctx) => {
    const target = await ctx.db.get("machines", machineId);
    if (!target?.environments) throw new Error("Missing inventory");
    await ctx.db.patch("machines", machineId, {
      environments: target.environments.map((item) => ({ ...item, revision: "b".repeat(64) })),
    });
  });
  await expect(device.query(internal.migrationPreviews.owned, { previewId })).rejects.toThrow(
    "migration_environment_changed",
  );
});
