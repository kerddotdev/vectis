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
      revoked: false,
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
