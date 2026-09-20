import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/jobs.ts": () => import("../../convex/jobs.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => vi.unstubAllEnvs());
test("job discovery is bound to the machine, repository, installation and current account owner", async () => {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const { machineId, accountId, bindingId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: 1,
    });
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 1,
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
    const job = {
      installationId: 3,
      repositoryId: 2,
      jobId: 4,
      runId: 5,
      name: "Build",
      status: "completed" as const,
      conclusion: "success",
      labels: [],
      runnerId: 6,
      runnerName: "vectis-test",
      updatedAt: 1,
    };
    await ctx.db.insert("githubJobs", job);
    await ctx.db.insert("githubJobs", { ...job, repositoryId: 99 });
    await ctx.db.insert("githubJobs", { ...job, installationId: 99 });
    return { machineId, accountId, bindingId };
  });
  const machine = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const jobs = await machine.query(api.jobs.list, { bindingId });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ jobId: 4, conclusion: "success" });
  await expect(
    t.withIdentity({ subject: "owner" }).query(api.jobs.list, { bindingId }),
  ).rejects.toThrow();
  await t.run(async (ctx) => ctx.db.patch("githubAccounts", accountId, { owner: "different" }));
  await expect(machine.query(api.jobs.list, { bindingId })).rejects.toThrow();
});

async function leaseFixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: 1,
    });
    const foreignId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "foreign",
      name: "Other Mac",
      createdAt: 1,
    });
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 1,
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
    const leaseId = await ctx.db.insert("runnerLeases", {
      owner: "owner",
      machineId,
      bindingId,
      environmentId: "mac",
      os: "macos",
      key: "runner",
      phase: "released",
      runnerId: 6,
      createdAt: 1,
      updatedAt: 1,
    });
    const job = {
      installationId: 3,
      repositoryId: 2,
      jobId: 4,
      runId: 5,
      name: "Build",
      status: "completed" as const,
      conclusion: "failure",
      labels: [],
      runnerId: 6,
      runnerName: `vectis-${leaseId}`,
      updatedAt: 1,
    };
    const jobId = await ctx.db.insert("githubJobs", job);
    await ctx.db.insert("githubJobs", { ...job, repositoryId: 99 });
    await ctx.db.insert("githubJobs", { ...job, installationId: 99 });
    return { machineId, foreignId, bindingId, leaseId, jobId, accountId, job };
  });
  const device = (id = ids.machineId) =>
    t.withIdentity({
      issuer: "https://machine.test",
      subject: id,
      credentialVersion: 0,
    });
  return { t, ...ids, device };
}

test("owned released leases find their actual job even after the binding is disabled", async () => {
  const { t, device, bindingId, leaseId } = await leaseFixture();
  await t.run(async (ctx) => ctx.db.patch("repositoryBindings", bindingId, { enabled: false }));
  expect(
    await device().query(api.jobs.forLeases, { leaseIds: [leaseId, leaseId, "missing"] }),
  ).toEqual([
    {
      leaseId,
      job: {
        jobId: 4,
        runId: 5,
        name: "Build",
        status: "completed",
        conclusion: "failure",
        labels: [],
        runnerId: 6,
        runnerName: `vectis-${leaseId}`,
        updatedAt: 1,
      },
    },
  ]);
});

test("a different machine with the same owner cannot observe a lease", async () => {
  const { device, foreignId, leaseId } = await leaseFixture();
  expect(await device(foreignId).query(api.jobs.forLeases, { leaseIds: [leaseId] })).toEqual([]);
});

test.each(["lease", "binding", "account"])(
  "observation rejects a changed %s owner",
  async (changed) => {
    const { t, device, leaseId, bindingId, accountId } = await leaseFixture();
    await t.run(async (ctx) => {
      if (changed === "lease") await ctx.db.patch("runnerLeases", leaseId, { owner: "other" });
      if (changed === "binding")
        await ctx.db.patch("repositoryBindings", bindingId, { owner: "other" });
      if (changed === "account")
        await ctx.db.patch("githubAccounts", accountId, { owner: "other" });
    });
    expect(await device().query(api.jobs.forLeases, { leaseIds: [leaseId] })).toEqual([]);
  },
);

test("a contradicting runner id or ambiguous runner name cannot identify a job", async () => {
  const { t, device, leaseId, jobId, job } = await leaseFixture();
  await t.run(async (ctx) => ctx.db.patch("githubJobs", jobId, { runnerId: 99 }));
  expect(await device().query(api.jobs.forLeases, { leaseIds: [leaseId] })).toEqual([]);
  await t.run(async (ctx) => ctx.db.patch("githubJobs", jobId, { runnerId: null }));
  expect(await device().query(api.jobs.forLeases, { leaseIds: [leaseId] })).toHaveLength(1);
  await t.run(async (ctx) => ctx.db.insert("githubJobs", { ...job, jobId: 7 }));
  expect(await device().query(api.jobs.forLeases, { leaseIds: [leaseId] })).toEqual([]);
});

test("lease queries authenticate machines and enforce the batch limit", async () => {
  const { t, device, leaseId } = await leaseFixture();
  await expect(t.query(api.jobs.forLeases, { leaseIds: [leaseId] })).rejects.toThrow();
  await expect(
    device().query(api.jobs.forLeases, { leaseIds: Array.from({ length: 21 }, () => leaseId) }),
  ).rejects.toThrow("invalid_lease_ids");
});
