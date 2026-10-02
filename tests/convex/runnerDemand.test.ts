import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
import { decodeCommand } from "../../packages/protocol/src/index.js";
const modules = {
  "../../convex/runnerDemand.ts": () => import("../../convex/runnerDemand.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/githubWebhook.ts": () => import("../../convex/githubWebhook.js"),
  "../../convex/githubDeliveries.ts": () => import("../../convex/githubDeliveries.js"),
  "../../convex/githubAppSetup.ts": () => import("../../convex/githubAppSetup.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
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
  const heartbeat = async (
    index: number,
    paused = false,
    runnerIdle = true,
    runnerSlots?: number,
  ) => {
    const host = ids.hosts[index];
    if (!host) throw new Error("Missing test host");
    await t
      .withIdentity({
        issuer: "https://machine.test",
        subject: host.machineId,
        credentialVersion: 0,
      })
      .mutation(api.machines.heartbeat, {
        paused,
        runnerIdle,
        ...(runnerSlots === undefined ? {} : { runnerSlots }),
      });
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
test("paused hosts and hosts with zero slots do not reserve new capacity", async () => {
  const { heartbeat, operations } = await fixture();
  await heartbeat(0, true, true, 3);
  await heartbeat(1, false, true, 0);
  expect(await operations()).toHaveLength(0);
  await heartbeat(0, false, false, 1);
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
test("unfinished, cancelled and action-required demand is not retried, and failures retry after a minute", async () => {
  const { t, heartbeat, operations } = await fixture();
  await heartbeat(0);
  const first = (await operations())[0];
  if (!first) throw new Error("Missing demand");
  for (const phase of ["claimed", "running", "cancelled", "action_required"] as const) {
    await t.run(async (ctx) => ctx.db.patch("operations", first._id, { phase }));
    await heartbeat(0);
    expect(await operations()).toHaveLength(1);
  }
  await t.run(async (ctx) =>
    ctx.db.patch("operations", first._id, { phase: "failed", updatedAt: Date.now() }),
  );
  await heartbeat(0);
  expect(await operations()).toHaveLength(1);
  await t.run(async (ctx) =>
    ctx.db.patch("operations", first._id, { updatedAt: Date.now() - 60000 }),
  );
  await heartbeat(0);
  const retry = (await operations()).find((item) => item._id !== first._id);
  expect(retry?.key).toMatch(/:2$/);
});
test("failed and successful retries share the same three attempts", async () => {
  const { t, heartbeat, operations } = await fixture();
  for (const phase of ["failed", "succeeded", "failed", "failed"] as const) {
    await heartbeat(0);
    await t.run(async (ctx) => {
      for (const operation of await ctx.db.query("operations").collect())
        await ctx.db.patch("operations", operation._id, { phase, updatedAt: Date.now() - 60000 });
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
  expect(decodeCommand(JSON.parse(scans[0]!.commandJson))).toMatchObject({
    type: "job.scan",
    automatic: true,
  });
  await t.run(async (ctx) => {
    for (const scan of await ctx.db.query("jobScans").collect())
      await ctx.db.patch("jobScans", scan._id, { scannedAt: Date.now() - 600000 });
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

async function addJobs(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  count: number,
  repositoryId = 2,
) {
  await t.run(async (ctx) => {
    for (let index = 0; index < count; index++)
      await ctx.db.insert("githubJobs", {
        installationId: 3,
        repositoryId,
        jobId: repositoryId * 100 + index,
        runId: 5,
        name: "Build",
        status: "queued",
        conclusion: null,
        labels: ["self-hosted", "macOS", "ARM64", "vectis-mac"],
        runnerId: null,
        runnerName: null,
        updatedAt: 0,
      });
  });
}

test("three free slots reserve the oldest three jobs once across duplicate heartbeats", async () => {
  const { t, heartbeat, operations, jobId } = await fixture();
  await addJobs(t, 3);
  await t.run((ctx) => ctx.db.patch("githubJobs", jobId, { updatedAt: Date.now() }));
  await heartbeat(0, false, false, 3);
  expect(
    (await operations()).map((operation) => decodeCommand(JSON.parse(operation.commandJson))),
  ).toMatchObject([{ jobId: 4 }, { jobId: 200 }, { jobId: 201 }]);
  await heartbeat(0, false, false, 3);
  expect(await operations()).toHaveLength(3);
  expect((await operations()).every((operation) => operation.phase === "accepted")).toBe(true);
});

test("bindings share slots round-robin and continue in repeated passes", async () => {
  const { t, heartbeat, operations, hosts, accountId } = await fixture();
  const host = hosts[0];
  if (!host) throw new Error("Missing host");
  const other = await t.run((ctx) =>
    ctx.db.insert("repositoryBindings", {
      owner: "owner",
      accountId,
      machineId: host.machineId,
      repositoryId: 7,
      repositoryName: "other",
      installationId: 3,
      environmentId: "mac",
      enabled: true,
      automatic: true,
      verifiedAt: 1,
    }),
  );
  await addJobs(t, 2);
  await addJobs(t, 3, 7);
  await heartbeat(0, false, true, 2);
  expect(
    (await operations()).map((operation) => decodeCommand(JSON.parse(operation.commandJson))),
  ).toMatchObject([
    { bindingId: host.bindingId, jobId: 4 },
    { bindingId: other, jobId: 700 },
  ]);
  await heartbeat(0, false, true, 6);
  expect(
    (await operations()).map((operation) => decodeCommand(JSON.parse(operation.commandJson))),
  ).toMatchObject([
    { jobId: 4 },
    { jobId: 700 },
    { jobId: 200 },
    { jobId: 701 },
    { jobId: 201 },
    { jobId: 702 },
  ]);
});

test.each(["accepted", "claimed", "running"] as const)(
  "legacy idle hosts reserve at most one runner while %s",
  async (phase) => {
    const { t, heartbeat, operations } = await fixture();
    await addJobs(t, 3);
    await heartbeat(0);
    const first = (await operations())[0];
    if (!first) throw new Error("Missing operation");
    await t.run((ctx) => ctx.db.patch("operations", first._id, { phase }));
    await heartbeat(0);
    expect(await operations()).toHaveLength(1);
  },
);

test.each(["claimed", "running"] as const)(
  "%s runners reserve capacity until a fresh heartbeat",
  async (phase) => {
    const { t, heartbeat, operations, hosts } = await fixture();
    await addJobs(t, 3);
    await heartbeat(0, false, true, 3);
    const host = hosts[0];
    if (!host) throw new Error("Missing host");
    await t.run(async (ctx) => {
      for (const operation of await ctx.db.query("operations").collect())
        await ctx.db.patch("operations", operation._id, { phase, updatedAt: Date.now() });
    });
    // A webhook can arrive after replay but before the next heartbeat.
    await t.run(async (ctx) => {
      const { scheduleRunnerDemand } = await import("../../convex/runnerDemand.js");
      const target = await ctx.db.get("machines", host.machineId);
      if (!target) throw new Error("Missing machine");
      await scheduleRunnerDemand(ctx, target);
    });
    expect(await operations()).toHaveLength(3);
    await t.run(async (ctx) => {
      for (const operation of await ctx.db.query("operations").collect())
        await ctx.db.patch("operations", operation._id, {
          phase: "running",
          updatedAt: Date.now() - 1000,
        });
    });
    await heartbeat(0, false, false, 1);
    expect(await operations()).toHaveLength(4);
  },
);

test("queued webhooks schedule changed jobs without a heartbeat", async () => {
  vi.useFakeTimers();
  const { t, operations, hosts, jobId } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.delete("githubJobs", jobId);
    for (const host of hosts) {
      await ctx.db.patch("machines", host.machineId, { paused: false });
      await ctx.db.insert("machinePresence", {
        machineId: host.machineId,
        runnerSlots: 1,
        lastSeenAt: Date.now(),
      });
    }
    await ctx.db.insert("githubApps", {
      appId: 1,
      slug: "test",
      ownerId: 1,
      clientId: "test",
      privateKey: "unused",
      clientSecret: "unused",
      webhookSecret: "secret",
    });
  });
  const deliver = async (deliveryId: string, name = "Build", status = "queued") => {
    const body = JSON.stringify({
      action: status,
      installation: { id: 3 },
      repository: { id: 2 },
      workflow_job: {
        id: 4,
        run_id: 5,
        name,
        status,
        conclusion: null,
        labels: ["self-hosted", "macOS", "ARM64", "vectis-mac"],
        runner_id: null,
        runner_name: null,
      },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(
      (
        await t.fetch("/github/webhook", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "workflow_job",
            "x-github-delivery": deliveryId,
            "x-hub-signature-256": signature,
          },
        })
      ).status,
    ).toBe(202);
  };
  await deliver("new");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await operations()).toHaveLength(1);
  const first = (await operations())[0];
  if (!first) throw new Error("Missing operation");
  await t.run((ctx) => ctx.db.patch("operations", first._id, { phase: "succeeded" }));
  await deliver("unchanged");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await operations()).toHaveLength(1);
  await deliver("changed", "Renamed");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await operations()).toHaveLength(2);
  await t.run(async (ctx) => {
    for (const operation of await ctx.db.query("operations").collect())
      await ctx.db.patch("operations", operation._id, { phase: "succeeded" });
  });
  await deliver("completed", "Renamed", "completed");
  await deliver("stale", "Build");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await operations()).toHaveLength(2);
});

test("a job waiting for approval gets a runner once GitHub queues it, but a cancellation stays final", async () => {
  vi.useFakeTimers();
  const { t, operations, hosts, jobId, heartbeat } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.delete("githubJobs", jobId);
    const host = hosts[0]!;
    await ctx.db.patch("machines", host.machineId, { paused: false });
    await ctx.db.insert("machinePresence", {
      machineId: host.machineId,
      runnerSlots: 1,
      lastSeenAt: Date.now(),
    });
    await ctx.db.delete("repositoryBindings", hosts[1]!.bindingId);
    await ctx.db.insert("githubApps", {
      appId: 1,
      slug: "test",
      ownerId: 1,
      clientId: "test",
      privateKey: "unused",
      clientSecret: "unused",
      webhookSecret: "secret",
    });
  });
  const deliver = async (deliveryId: string, status: string) => {
    const body = JSON.stringify({
      action: status,
      installation: { id: 3 },
      repository: { id: 2 },
      workflow_job: {
        id: 4,
        run_id: 5,
        name: "Release",
        status,
        conclusion: null,
        labels: ["self-hosted", "macOS", "ARM64", "vectis-mac"],
        runner_id: null,
        runner_name: null,
      },
    });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    const response = await t.fetch("/github/webhook", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "workflow_job",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature,
      },
    });
    expect(response.status).toBe(202);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const job = () =>
    t.run(async (ctx) => (await ctx.db.query("githubJobs").collect()).map((item) => item.status));
  const cancelAll = () =>
    t.run(async (ctx) => {
      for (const operation of await ctx.db.query("operations").collect())
        await ctx.db.patch("operations", operation._id, {
          phase: "cancelled",
          updatedAt: Date.now(),
        });
    });

  const runners = async () =>
    (await operations()).filter((item) => JSON.parse(item.commandJson).type === "runner.run");

  await deliver("queued", "queued");
  expect(await runners()).toHaveLength(1);
  await deliver("waiting", "waiting");
  expect(await job()).toEqual(["waiting"]);
  await deliver("pending", "pending");
  expect(await job()).toEqual(["waiting"]);
  const first = (await runners())[0]!;
  await t.run((ctx) =>
    ctx.db.patch("operations", first._id, { phase: "running", updatedAt: Date.now() }),
  );
  // Approval can arrive while the runner that found the job waiting still cleans up.
  vi.advanceTimersByTime(1000);
  await deliver("approved", "queued");
  expect(await runners()).toHaveLength(1);
  vi.advanceTimersByTime(1000);
  await cancelAll();
  await heartbeat(0, false, true, 1);
  const keys = (await runners()).map((item) => item.key);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toMatch(/:2$/);

  await cancelAll();
  vi.advanceTimersByTime(1000);
  await deliver("repeated", "queued");
  await heartbeat(0, false, true, 1);
  expect(await runners()).toHaveLength(2);
});

test.each([undefined, 0, 1])(
  "lease release schedules against stored slots %s without inventing capacity",
  async (runnerSlots) => {
    const { t, hosts, operations } = await fixture();
    const host = hosts[0];
    if (!host) throw new Error("Missing host");
    const leaseId = await t.run(async (ctx) => {
      await ctx.db.patch("machines", host.machineId, { paused: false });
      await ctx.db.insert("machinePresence", {
        machineId: host.machineId,
        runnerIdle: true,
        lastSeenAt: Date.now(),
        ...(runnerSlots === undefined ? {} : { runnerSlots }),
      });
      return ctx.db.insert("runnerLeases", {
        owner: "owner",
        machineId: host.machineId,
        bindingId: host.bindingId,
        environmentId: "mac",
        os: "macos",
        key: "previous",
        phase: "ready",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t
      .withIdentity({
        issuer: "https://machine.test",
        subject: host.machineId,
        credentialVersion: 0,
      })
      .mutation(internal.runnerLeases.released, { id: leaseId });
    expect(await operations()).toHaveLength(runnerSlots === 0 ? 0 : 1);
  },
);

test.each([undefined, 1])(
  "active leases block only legacy hosts (slots %s)",
  async (runnerSlots) => {
    const { t, hosts, heartbeat, operations } = await fixture();
    const host = hosts[0];
    if (!host) throw new Error("Missing host");
    await t.run((ctx) =>
      ctx.db.insert("runnerLeases", {
        owner: "owner",
        machineId: host.machineId,
        bindingId: host.bindingId,
        environmentId: "mac",
        os: "macos",
        key: "active",
        phase: "ready",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await heartbeat(0, false, true, runnerSlots);
    expect(await operations()).toHaveLength(runnerSlots === undefined ? 0 : 1);
  },
);

test("heartbeats keep liveness off the machine document", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const { t, hosts, heartbeat } = await fixture();
  const host = hosts[0];
  if (!host) throw new Error("Missing host");
  const read = () =>
    t.run(async (ctx) => ({
      machine: await ctx.db.get("machines", host.machineId),
      presence: await ctx.db
        .query("machinePresence")
        .withIndex("by_machine", (q) => q.eq("machineId", host.machineId))
        .unique(),
    }));
  await heartbeat(0, false, true, 2);
  const first = await read();
  expect(first.machine).not.toHaveProperty("lastSeenAt");
  expect(first.presence).toMatchObject({ lastSeenAt: 1_000_000, runnerIdle: true, runnerSlots: 2 });
  vi.setSystemTime(1_030_000);
  await heartbeat(0, false, false);
  const second = await read();
  expect(second.machine).toEqual(first.machine);
  expect(second.presence).toMatchObject({
    lastSeenAt: 1_030_000,
    runnerIdle: false,
    runnerSlots: 2,
  });
  await heartbeat(0, true, false);
  expect((await read()).machine).toEqual({ ...first.machine, paused: true });
});

test("legacy liveness on the machine document is ignored", async () => {
  const { t, hosts, heartbeat, operations } = await fixture();
  const host = hosts[0];
  if (!host) throw new Error("Missing host");
  await t.run((ctx) =>
    ctx.db.patch("machines", host.machineId, {
      paused: false,
      runnerSlots: 1,
      lastSeenAt: Date.now(),
    }),
  );
  await t.mutation(internal.runnerDemand.forMachine, { machineId: host.machineId });
  expect(await operations()).toHaveLength(0);
  await heartbeat(0, false, true, 1);
  expect(await operations()).toHaveLength(1);
});

test("a heartbeat that readies an environment schedules against the new inventory", async () => {
  const { t, hosts, operations } = await fixture();
  const host = hosts[0];
  if (!host) throw new Error("Missing host");
  const environment = { id: "mac", name: "Mac", os: "macos" as const, cpu: 2, memoryMiB: 4096 };
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: host.machineId,
    credentialVersion: 0,
  });
  const heartbeat = (state: "ready" | "action_required") =>
    device.mutation(api.machines.heartbeat, {
      paused: false,
      runnerSlots: 1,
      environments: [{ ...environment, state }],
    });
  await heartbeat("action_required");
  expect(await operations()).toHaveLength(0);
  await heartbeat("ready");
  expect(await operations()).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.get("machines", host.machineId)))?.environments).toEqual([
    { ...environment, state: "ready" },
  ]);
});

test("manual and disabled bindings are neither scanned nor scheduled", async () => {
  const { t, hosts, heartbeat, operations } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.insert("githubApps", {
      appId: 1,
      slug: "test",
      ownerId: 1,
      clientId: "test",
      privateKey: "unused",
      clientSecret: "unused",
      webhookSecret: "unused",
    });
    await ctx.db.patch("repositoryBindings", hosts[0]!.bindingId, { automatic: false });
    await ctx.db.patch("repositoryBindings", hosts[1]!.bindingId, { enabled: false });
  });
  await heartbeat(0, false, true, 1);
  await heartbeat(1, false, true, 1);
  expect(await operations()).toHaveLength(0);
});

test("job scans wait for a configured GitHub App and leave bindings untouched", async () => {
  const { t, hosts, heartbeat, operations } = await fixture();
  const bindings = () => t.run((ctx) => ctx.db.query("repositoryBindings").collect());
  const scans = () => t.run((ctx) => ctx.db.query("jobScans").collect());
  const scanOperations = async () =>
    (await operations()).filter((item) => JSON.parse(item.commandJson).type === "job.scan");
  const before = await bindings();
  await heartbeat(0);
  expect(await scans()).toHaveLength(0);
  await t.run((ctx) =>
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
  expect(await scans()).toMatchObject([{ bindingId: hosts[0]?.bindingId }]);
  expect(await scanOperations()).toHaveLength(1);
  await heartbeat(0);
  expect(await scanOperations()).toHaveLength(1);
  expect(await bindings()).toEqual(before);
});
