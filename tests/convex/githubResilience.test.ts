import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
import { unmatchableLabels } from "../../packages/github/src/job.js";
import { Service } from "../../apps/server/src/service.js";
import { Store } from "../../apps/server/src/store.js";
import { VmRuntime } from "../../packages/runner/src/runtime.js";
import { startCloudRelay } from "../../packages/client/src/cloud-relay.js";
import { VectisClient } from "../../packages/client/src/index.js";

const transport = vi.hoisted(() => ({
  action:
    vi.fn<
      (reference: FunctionReference<"action">, args: Record<string, unknown>) => Promise<unknown>
    >(),
}));
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    action = transport.action;
    query = async () => new Promise<never>(() => {});
    onUpdate = () => () => {};
    client = {
      connectionState: () => ({ isWebSocketConnected: true }),
      subscribeToConnectionState: () => () => {},
    };
    setAuth(_fetchToken: unknown, changed: (value: boolean) => void) {
      changed(true);
    }
    async close() {}
  },
}));
const modules = {
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/githubWebhook.ts": () => import("../../convex/githubWebhook.js"),
  "../../convex/githubDeliveries.ts": () => import("../../convex/githubDeliveries.js"),
  "../../convex/githubAppSetup.ts": () => import("../../convex/githubAppSetup.js"),
  "../../convex/githubJobs.ts": () => import("../../convex/githubJobs.js"),
  "../../convex/githubRuns.ts": () => import("../../convex/githubRuns.js"),
  "../../convex/runReceipts.ts": () => import("../../convex/runReceipts.js"),
  "../../convex/jobs.ts": () => import("../../convex/jobs.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/runnerDemand.ts": () => import("../../convex/runnerDemand.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const job = {
  id: 4,
  run_id: 5,
  name: "Build",
  status: "queued",
  conclusion: null,
  labels: ["vectis-mac"],
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  transport.action.mockReset();
});
async function fixture() {
  vi.useFakeTimers();
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected fetch");
    }),
  );
  const t = convexTest(schema, modules);
  const { machineId, bindingId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "local",
      name: "Mac",
      createdAt: 1,
      paused: false,
      environments: [
        { id: "mac", name: "Mac", os: "macos", cpu: 2, memoryMiB: 4096, state: "ready" },
      ],
    });
    await ctx.db.insert("machinePresence", { machineId, lastSeenAt: Date.now(), runnerSlots: 1 });
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
      automatic: true,
      verifiedAt: 1,
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
    return { machineId, bindingId };
  });
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const webhook = async (input: Record<string, unknown>, delivery = "delivery") => {
    const body = JSON.stringify({
      action: "queued",
      installation: { id: 3 },
      repository: { id: 2 },
      workflow_job: input,
    });
    return t.fetch("/github/webhook", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "workflow_job",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test").update(body).digest("hex")}`,
      },
    });
  };
  const stubApi = (read: (url: string) => Response) => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/installation"))
        return Response.json({
          id: 3,
          app_id: 42,
          account: { id: 7, type: "User" },
          suspended_at: null,
        });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "scoped-test-token" });
      if (url === "https://api.github.com/repos/owner/sandbox")
        return Response.json({ id: 2, private: true, owner: { id: 7 } });
      return read(url);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  return { t, device, bindingId, machineId, webhook, stubApi };
}

test("a signed webhook truncates a 300-character job name and drops an overlong URL", async () => {
  const { t, webhook } = await fixture();
  expect(
    (
      await webhook({
        ...job,
        name: "a".repeat(300),
        html_url: "https://github.com/" + "a".repeat(500),
      })
    ).status,
  ).toBe(202);
  const stored = await t.run((ctx) => ctx.db.query("githubJobs").unique());
  expect(stored?.name).toBe("a".repeat(200));
  expect(stored).not.toHaveProperty("htmlUrl");
  expect(await t.run((ctx) => ctx.db.query("githubDeliveries").collect())).toHaveLength(1);
});

test("an unknown webhook status is recorded as waiting and the existing scan can repair it", async () => {
  const { t, device, bindingId, webhook, stubApi } = await fixture();
  expect((await webhook({ ...job, status: "future_status" })).status).toBe(202);
  expect(await t.run((ctx) => ctx.db.query("githubDeliveries").collect())).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("githubJobs").unique())).toMatchObject({
    status: "waiting",
  });
  expect(await device.query(internal.jobs.pendingRuns, { bindingId })).toMatchObject({
    runIds: [5],
  });
  stubApi((url) =>
    url.includes("/actions/runs?")
      ? Response.json({ total_count: 0, workflow_runs: [] })
      : Response.json({ total_count: 1, jobs: [{ ...job, name: "n".repeat(300) }] }),
  );
  expect(await device.action(api.githubJobs.scan, { bindingId })).toEqual({
    complete: true,
    jobs: 1,
    runs: 1,
  });
  expect(await t.run((ctx) => ctx.db.query("githubJobs").unique())).toMatchObject({
    status: "queued",
    name: "n".repeat(200),
  });
});

test.each([
  { labels: Array.from({ length: 101 }, () => "vectis-mac") },
  { labels: ["vectis-mac", "x".repeat(101)] },
])("oversized labels are stored but never reserve runner capacity", async ({ labels }) => {
  const { t, webhook, machineId } = await fixture();
  expect((await webhook({ ...job, labels })).status).toBe(202);
  expect(await t.run((ctx) => ctx.db.query("githubJobs").unique())).toMatchObject({
    status: "queued",
    labels: expect.arrayContaining([unmatchableLabels]),
  });
  await t.mutation(internal.runnerDemand.forMachine, { machineId });
  expect(await t.run((ctx) => ctx.db.query("runnerDemands").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(0);
  await webhook(job, "valid-labels");
  await t.mutation(internal.runnerDemand.forMachine, { machineId });
  expect(await t.run((ctx) => ctx.db.query("runnerDemands").collect())).toHaveLength(1);
});

test("API refresh applies the same bounds and unmatchable label marker", async () => {
  const { t, device, bindingId, stubApi } = await fixture();
  stubApi(() =>
    Response.json({
      ...job,
      name: "a".repeat(300),
      labels: Array.from({ length: 101 }, () => "vectis-mac"),
    }),
  );
  const result = await device.action(api.githubJobs.refresh, { bindingId, jobId: 4 });
  expect(result.name).toBe("a".repeat(200));
  expect(result.labels).toContain(unmatchableLabels);
  expect(await t.run((ctx) => ctx.db.query("githubJobs").collect())).toHaveLength(1);
});

test.each(["github_unavailable", "github_rate_limited"] as const)(
  "%s survives a Convex action, relay and local operation storage",
  async (code) => {
    const f = await fixture();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    f.stubApi(() =>
      code === "github_unavailable"
        ? new Response(null, { status: 502 })
        : new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    );
    transport.action.mockImplementation(async (reference) => {
      expect(getFunctionName(reference)).toBe("githubJobs:refresh");
      return f.device.action(api.githubJobs.refresh, { bindingId: f.bindingId, jobId: 4 });
    });
    const home = await mkdtemp(join(tmpdir(), "vectis-github-errors-"));
    const store = new Store(join(home, "state.sqlite"));
    const relay = startCloudRelay(
      {
        deploymentUrl: "https://isolated-test.convex.cloud",
        machineId: "machine",
        localId: store.snapshot().machine.id,
      },
      new VectisClient({ url: "http://127.0.0.1:1", token: "unused" }),
      { get: async () => null },
      () => {},
      () => {},
      () => {},
    );
    const service = new Service(store, new VmRuntime({ home }), () => relay);
    try {
      const operation = service.submit("refresh", {
        type: "job.refresh",
        bindingId: f.bindingId,
        jobId: 4,
      });
      await service.drain();
      await vi.advanceTimersByTimeAsync(4000);
      expect(store.snapshot().operations.find((entry) => entry.id === operation.id)).toMatchObject({
        status: "failed",
        result: { code },
      });
    } finally {
      await service.close();
      await relay.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
