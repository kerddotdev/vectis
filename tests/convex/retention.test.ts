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
const job = (
  jobId: number,
  updatedAt: number,
  status: "queued" | "waiting" | "in_progress" | "completed",
) => ({
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

test("the sweep expires old jobs and released leases but keeps unreleased leases", async () => {
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
    await ctx.db.insert("githubJobs", job(4, now - day, "queued"));
    await ctx.db.insert("githubJobs", job(5, now - windows.jobs - day, "in_progress"));
    await ctx.db.insert("githubJobs", job(6, now - windows.jobs - day, "waiting"));
    await ctx.db.insert("githubJobs", job(7, now - windows.jobs, "in_progress"));
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
      ["preparing", "preparing", now - windows.leases - day],
      ["attention", "action_required", now - windows.leases - day],
      ["recent", "ready", now - day],
      ["boundary", "ready", now - windows.leases],
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
    jobs: [3, 4, 7],
    operations: ["fresh", "stuck"],
    leases: ["ready", "preparing", "attention", "recent", "boundary"],
    controllers: 0,
    pairings: 0,
  });
  vi.useRealTimers();
});

test("the daily sweep expires all receipt states after 30 days in bounded batches", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const cutoff = now - windows.runReceipts;
    expect(windows.runReceipts).toBe(30 * day);
    await t.run(async (ctx) => {
      const machineId = await ctx.db.insert("machines", {
        owner: "owner",
        localId: "local",
        name: "Mac",
        createdAt: 1,
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
        accountId,
        machineId,
        repositoryId: 2,
        repositoryName: "sandbox",
        installationId: 1,
        environmentId: "ubuntu",
        enabled: true,
        verifiedAt: 1,
      });
      const states = ["submitted", "accepted", "uncertain", "rejected"] as const;
      for (const state of states)
        for (let index = 0; index < 126; index++)
          await ctx.db.insert("runCommandReceipts", {
            machineId,
            bindingId,
            key: `old-${state}-${index}`,
            requestHash: "a".repeat(64),
            state,
            createdAt: cutoff - day,
            updatedAt: cutoff - 1,
          });
      for (const [key, updatedAt] of [
        ["boundary", cutoff],
        ["recent", now - day],
        ["fresh", now],
      ] as const)
        await ctx.db.insert("runCommandReceipts", {
          machineId,
          bindingId,
          key,
          requestHash: "b".repeat(64),
          state: "accepted",
          createdAt: cutoff - day,
          updatedAt,
          outcome: {
            state: "accepted",
            cancellation: "requested",
            message: "GitHub accepted the cancellation; the run is still stopping.",
            runId: 5,
          },
        });
    });
    await t.mutation(internal.retention.sweep, {});
    expect(await t.run((ctx) => ctx.db.query("runCommandReceipts").collect())).toHaveLength(7);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const receipts = await t.run((ctx) => ctx.db.query("runCommandReceipts").collect());
    expect(receipts.map((receipt) => receipt.key).sort()).toEqual(["boundary", "fresh", "recent"]);
    expect(receipts.every((receipt) => receipt.outcome?.state === "accepted")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
