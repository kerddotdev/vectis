import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { internal } from "../../convex/_generated/api.js";
import { windows } from "../../convex/retention.js";

const modules = {
  "../../convex/retention.ts": () => import("../../convex/retention.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const day = 24 * 60 * 60 * 1000;
const job = (jobId: number, updatedAt: number, status: "queued" | "completed") => ({
  installationId: 1,
  repositoryId: 2,
  jobId,
  runId: 5,
  name: "Build",
  status,
  conclusion: status === "completed" ? "success" : null,
  labels: ["vectis-ubuntu"],
  runnerId: null,
  runnerName: null,
  updatedAt,
});

test("the sweep deletes records past their retention window and keeps unfinished work", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("githubDeliveries", {
      deliveryId: "old",
      event: "workflow_job",
      receivedAt: now - windows.deliveries - day,
    });
    await ctx.db.insert("githubDeliveries", {
      deliveryId: "recent",
      event: "workflow_job",
      receivedAt: now - day,
    });
    await ctx.db.insert("githubJobs", job(1, now - windows.jobs - day, "completed"));
    await ctx.db.insert("githubJobs", job(2, now - windows.jobs - day, "queued"));
    await ctx.db.insert("githubJobs", job(3, now - day, "completed"));
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: 1,
    });
    for (const [key, phase, updatedAt] of [
      ["done", "succeeded", now - windows.operations - day],
      ["stuck", "running", now - windows.operations - day],
      ["fresh", "succeeded", now - day],
    ] as const)
      await ctx.db.insert("operations", {
        owner: "owner",
        machineId,
        key,
        commandJson: "{}",
        phase,
        createdAt: 1,
        updatedAt,
      });
    for (const [key, phase, updatedAt] of [
      ["released", "released", now - windows.leases - day],
      ["ready", "ready", now - windows.leases - day],
    ] as const)
      await ctx.db.insert("runnerLeases", {
        owner: "owner",
        machineId,
        bindingId: await ctx.db.insert("repositoryBindings", {
          owner: "owner",
          accountId: await ctx.db.insert("githubAccounts", {
            owner: "owner",
            githubId: 7,
            login: "owner",
            installations: [],
            verifiedAt: 1,
          }),
          machineId,
          repositoryId: 2,
          repositoryName: "sandbox",
          installationId: 1,
          environmentId: "ubuntu",
          enabled: true,
          verifiedAt: 1,
        }),
        environmentId: "ubuntu",
        os: "linux",
        key,
        phase,
        createdAt: 1,
        updatedAt,
      });
    await ctx.db.insert("controllers", {
      owner: "owner",
      name: "Old CLI",
      requestDigest: "a".repeat(64),
      credentialDigest: "b".repeat(64),
      pairingExpiresAt: 1,
      expiresAt: now - windows.controllers - day,
      revoked: false,
      createdAt: 1,
    });
    await ctx.db.insert("pairings", {
      owner: "owner",
      requestDigest: "c".repeat(64),
      machineId,
      credentialVersion: 1,
      expiresAt: now - 2 * day,
    });
  });
  await t.mutation(internal.retention.sweep, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const left = await t.run(async (ctx) => ({
    deliveries: (await ctx.db.query("githubDeliveries").collect()).map((row) => row.deliveryId),
    jobs: (await ctx.db.query("githubJobs").collect()).map((row) => row.jobId).sort(),
    operations: (await ctx.db.query("operations").collect()).map((row) => row.key).sort(),
    leases: (await ctx.db.query("runnerLeases").collect()).map((row) => row.key),
    controllers: (await ctx.db.query("controllers").collect()).length,
    pairings: (await ctx.db.query("pairings").collect()).length,
  }));
  expect(left).toEqual({
    deliveries: ["recent"],
    jobs: [2, 3],
    operations: ["fresh", "stuck"],
    leases: ["ready"],
    controllers: 0,
    pairings: 0,
  });
  vi.useRealTimers();
});
