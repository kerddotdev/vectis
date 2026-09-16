import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 1,
      login: "owner",
      installations: [],
      verifiedAt: 1,
    });
    const hosts = [];
    for (const localId of ["first", "second"]) {
      const machineId = await ctx.db.insert("machines", {
        owner: "owner",
        localId,
        name: localId,
        revoked: false,
        createdAt: 1,
        environments: [
          { id: "mac", name: "Mac", os: "macos", cpu: 2, memoryMiB: 4096, state: "ready" },
        ],
      });
      const bindingId = await ctx.db.insert("repositoryBindings", {
        owner: "owner",
        accountId,
        machineId,
        repositoryId: 2,
        repositoryName: "sandbox",
        installationId: 3,
        environmentId: "mac",
        enabled: true,
        automatic: true,
        verifiedAt: 1,
      });
      hosts.push({ machineId, bindingId });
    }
    const jobId = await ctx.db.insert("githubJobs", {
      installationId: 3,
      repositoryId: 2,
      jobId: 4,
      runId: 5,
      name: "Build",
      status: "queued",
      conclusion: null,
      labels: ["self-hosted", "macOS", "ARM64", "vectis-mac"],
      runnerId: null,
      runnerName: null,
      updatedAt: 1,
    });
    return { hosts, accountId, jobId };
  });
  const heartbeat = async (index: number, paused = false, runnerIdle = true) => {
    const host = ids.hosts[index];
    if (!host) throw new Error("Missing test host");
    await t
      .withIdentity({
        issuer: "https://machine.test",
        subject: host.machineId,
        credentialVersion: 0,
      })
      .mutation(api.machines.heartbeat, { paused, runnerIdle });
  };
  const operations = () => t.run(async (ctx) => ctx.db.query("operations").collect());
  return { t, ...ids, heartbeat, operations };
}
test("duplicate heartbeats and competing machines reserve one demand operation", async () => {
  const { heartbeat, operations, hosts } = await fixture();
  await heartbeat(0);
  await heartbeat(0);
  await heartbeat(1);
  const queued = await operations();
  expect(queued).toHaveLength(1);
  expect(queued[0]?.machineId).toBe(hosts[0]?.machineId);
  expect(JSON.parse(queued[0]?.commandJson ?? "{}")).toMatchObject({
    type: "runner.run",
    jobId: 4,
  });
});
test("paused or occupied hosts do not reserve new capacity", async () => {
  const { heartbeat, operations } = await fixture();
  await heartbeat(0, true);
  await heartbeat(1, false, false);
  expect(await operations()).toHaveLength(0);
  await heartbeat(0);
  expect(await operations()).toHaveLength(1);
});
test("a fork repository or incompatible labels cannot inherit the upstream capacity", async () => {
  const { t, jobId, heartbeat, operations } = await fixture();
  await t.run(async (ctx) => ctx.db.patch("githubJobs", jobId, { repositoryId: 99 }));
  await heartbeat(0);
  expect(await operations()).toHaveLength(0);
  await t.run(async (ctx) =>
    ctx.db.patch("githubJobs", jobId, { repositoryId: 2, labels: ["vectis-mac", "X64"] }),
  );
  await heartbeat(0);
  expect(await operations()).toHaveLength(0);
});
test("revoked account ownership prevents automatic scheduling", async () => {
  const { t, accountId, heartbeat, operations } = await fixture();
  await t.run(async (ctx) => ctx.db.patch("githubAccounts", accountId, { owner: "other" }));
  await heartbeat(0);
  expect(await operations()).toHaveLength(0);
});
test("failed demand is not automatically retried and successful retries are bounded", async () => {
  const { t, heartbeat, operations } = await fixture();
  await heartbeat(0);
  const first = (await operations())[0];
  if (!first) throw new Error("Missing demand");
  await t.run(async (ctx) => ctx.db.patch("operations", first._id, { phase: "failed" }));
  await heartbeat(1);
  expect(await operations()).toHaveLength(1);
  await t.run(async (ctx) => ctx.db.patch("operations", first._id, { phase: "succeeded" }));
  for (let attempt = 0; attempt < 4; attempt++) {
    await heartbeat(0);
    await t.run(async (ctx) => {
      for (const operation of await ctx.db.query("operations").collect())
        await ctx.db.patch("operations", operation._id, { phase: "succeeded" });
    });
  }
  expect(await operations()).toHaveLength(3);
});

test("repository scans are deduplicated across machines and retry on later heartbeats", async () => {
  const { t, heartbeat, operations } = await fixture();
  await t.run(async (ctx) =>
    ctx.db.insert("githubApps", {
      appId: 1,
      slug: "test",
      ownerId: 1,
      clientId: "test",
      privateKey: "unused",
      clientSecret: "unused",
      webhookSecret: "unused",
    }),
  );
  await heartbeat(0);
  await heartbeat(1);
  await heartbeat(0);
  const scans = (await operations()).filter(
    (item) => JSON.parse(item.commandJson).type === "job.scan",
  );
  expect(scans).toHaveLength(1);
  await t.run(async (ctx) => {
    for (const binding of await ctx.db.query("repositoryBindings").collect())
      await ctx.db.patch("repositoryBindings", binding._id, { lastJobScanAt: Date.now() - 600000 });
    await ctx.db.patch("operations", scans[0]!._id, { key: "old-scan", phase: "failed" });
  });
  await heartbeat(0);
  expect(
    (await operations()).filter((item) => JSON.parse(item.commandJson).type === "job.scan"),
  ).toHaveLength(2);
});
test("repository polling honors pause and revoked account ownership", async () => {
  const { t, heartbeat, operations, accountId } = await fixture();
  await t.run(async (ctx) =>
    ctx.db.insert("githubApps", {
      appId: 1,
      slug: "test",
      ownerId: 1,
      clientId: "test",
      privateKey: "unused",
      clientSecret: "unused",
      webhookSecret: "unused",
    }),
  );
  await heartbeat(0, true);
  await t.run(async (ctx) => ctx.db.patch("githubAccounts", accountId, { owner: "other" }));
  await heartbeat(1);
  expect(await operations()).toHaveLength(0);
});
