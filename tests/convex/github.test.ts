import { createHash, createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/githubHttp.ts": () => import("../../convex/githubHttp.js"),
  "../../convex/githubWebhook.ts": () => import("../../convex/githubWebhook.js"),
  "../../convex/githubDeliveries.ts": () => import("../../convex/githubDeliveries.js"),
  "../../convex/githubAppSetup.ts": () => import("../../convex/githubAppSetup.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
afterEach(() => vi.unstubAllGlobals());
const state = "a".repeat(64);
const stateDigest = createHash("sha256").update(state).digest("hex");
const app = {
  id: 123,
  slug: "vectis-test",
  owner: { id: 42 },
  client_id: "client",
  client_secret: "client-secret",
  pem: "private-key",
  webhook_secret: "webhook-secret",
};
test("manifest conversion stores credentials only in the backend and consumes the setup", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.githubAppSetup.create, {
    stateDigest,
    ownerId: 42,
    ownerLogin: "test-owner",
  });
  const convert = vi.fn(async () => Response.json(app));
  vi.stubGlobal("fetch", convert);
  expect((await t.fetch("/github/manifest/callback?state=wrong&code=test")).status).toBe(400);
  const response = await t.fetch(`/github/manifest/callback?state=${state}&code=test`);
  expect(response.status).toBe(200);
  const body = await response.text();
  for (const secret of [app.client_secret, app.pem, app.webhook_secret])
    expect(body).not.toContain(secret);
  const stored = await t.run(async (ctx) => ctx.db.query("githubApps").first());
  expect(stored?.appId).toBe(123);
  expect((await t.fetch(`/github/manifest/callback?state=${state}&code=test`)).status).toBe(403);
  expect(convert).toHaveBeenCalledTimes(1);
});
test("a different GitHub owner cannot replace the configured app", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.githubAppSetup.create, {
    stateDigest,
    ownerId: 7,
    ownerLogin: "other-owner",
  });
  vi.stubGlobal("fetch", async () => Response.json(app));
  expect((await t.fetch(`/github/manifest/callback?state=${state}&code=test`)).status).toBe(403);
  expect(await t.run(async (ctx) => ctx.db.query("githubApps").first())).toBeNull();
});
test("webhooks verify exact bytes and repeated deliveries store no duplicate capacity demand", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) =>
    ctx.db.insert("githubApps", {
      appId: 123,
      slug: "test",
      ownerId: 42,
      clientId: "test",
      privateKey: "test",
      clientSecret: "test",
      webhookSecret: app.webhook_secret,
    }),
  );
  const payload = JSON.stringify({
    action: "queued",
    installation: { id: 1 },
    repository: { id: 2 },
    workflow_job: {
      id: 3,
      run_id: 4,
      name: "Build",
      status: "queued",
      conclusion: null,
      labels: ["self-hosted"],
      runner_id: null,
      runner_name: null,
    },
    private_build_data: "not retained",
  });
  const signature = `sha256=${createHmac("sha256", app.webhook_secret).update(payload).digest("hex")}`;
  const request = (body: string) =>
    t.fetch("/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "workflow_job",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signature,
      },
      body,
    });
  expect((await request(payload + " ")).status).toBe(401);
  expect(await (await request(payload)).json()).toEqual({ accepted: true, duplicate: false });
  expect(await (await request(payload)).json()).toEqual({ accepted: true, duplicate: true });
  const rows = await t.run(async (ctx) => ctx.db.query("githubDeliveries").collect());
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("not retained");
});

test("job tracking ignores late state regressions and retains only bounded metadata", async () => {
  const t = convexTest(schema, modules);
  const common = {
    event: "workflow_job",
    installationId: 1,
    repositoryId: 2,
    jobId: 3,
    job: {
      id: 3,
      run_id: 4,
      name: "Build",
      status: "completed" as const,
      conclusion: "success",
      labels: ["self-hosted", "vectis-test"],
      runner_id: 5,
      runner_name: "vectis-owned",
    },
  };
  await t.mutation(internal.githubDeliveries.accept, { ...common, deliveryId: "complete" });
  await t.mutation(internal.githubDeliveries.accept, {
    ...common,
    deliveryId: "late",
    job: {
      ...common.job,
      status: "queued",
      conclusion: null,
      runner_id: null,
      runner_name: null,
    },
  });
  const jobs = await t.run(async (ctx) => ctx.db.query("githubJobs").collect());
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ status: "completed", conclusion: "success", runnerId: 5 });
  await expect(
    t.mutation(internal.githubDeliveries.accept, {
      ...common,
      deliveryId: "oversized",
      job: {
        ...common.job,
        labels: Array.from({ length: 101 }, () => "label"),
      },
    }),
  ).rejects.toThrow();
});
