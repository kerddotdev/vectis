import { generateKeyPairSync, createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/githubWebhook.ts": () => import("../../convex/githubWebhook.js"),
  "../../convex/githubDeliveries.ts": () => import("../../convex/githubDeliveries.js"),
  "../../convex/githubAppSetup.ts": () => import("../../convex/githubAppSetup.js"),
  "../../convex/runnerDemand.ts": () => import("../../convex/runnerDemand.js"),
  "../../convex/jobs.ts": () => import("../../convex/jobs.js"),
  "../../convex/githubJobs.ts": () => import("../../convex/githubJobs.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  const t = convexTest(schema, modules);
  const { machineId, bindingId } = await t.run(async (ctx) => {
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
      machineId,
      accountId,
      repositoryId: 2,
      repositoryName: "sandbox",
      installationId: 3,
      environmentId: "mac",
      enabled: true,
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
  let beforeJob: (() => Promise<void>) | undefined;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 3,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "read-only-test-token" });
    if (url.endsWith("/actions/jobs/4")) {
      await beforeJob?.();
      return Response.json({
        id: 4,
        run_id: 5,
        name: "Build",
        status: "completed",
        conclusion: "success",
        labels: ["vectis-mac"],
        runner_id: 6,
        runner_name: "vectis-test",
      });
    }
    return Response.json({ id: 2, private: true, owner: { id: 7 } });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    t,
    bindingId,
    machineId,
    fetch,
    setBeforeJob: (callback: () => Promise<void>) => {
      beforeJob = callback;
    },
    device: t.withIdentity({
      issuer: "https://machine.test",
      subject: machineId,
      credentialVersion: 0,
    }),
  };
}
test("recovers a completely missing webhook using the authorized repository API", async () => {
  const { device, bindingId, t } = await fixture();
  expect(await device.action(api.githubJobs.refresh, { bindingId, jobId: 4 })).toEqual({
    jobId: 4,
    runId: 5,
    name: "Build",
    runnerId: 6,
    runnerName: "vectis-test",
    updatedAt: expect.any(Number),
    labels: ["vectis-mac"],
    status: "completed",
    conclusion: "success",
  });
  expect(await device.query(api.jobs.list, { bindingId })).toHaveLength(1);
  expect(
    JSON.stringify(await t.run(async (ctx) => ctx.db.query("githubJobs").collect())),
  ).not.toContain("read-only-test-token");
});
test("removing the machine during the API request prevents persisting an authorized-looking result", async () => {
  const { device, bindingId, t, machineId, setBeforeJob } = await fixture();
  setBeforeJob(async () => {
    await t.run(async (ctx) => ctx.db.delete("machines", machineId));
  });
  await expect(device.action(api.githubJobs.refresh, { bindingId, jobId: 4 })).rejects.toThrow();
  expect(await t.run(async (ctx) => ctx.db.query("githubJobs").collect())).toHaveLength(0);
});
test("disabled bindings cannot request API access", async () => {
  const { device, bindingId, t, fetch } = await fixture();
  await t.run(async (ctx) => ctx.db.patch("repositoryBindings", bindingId, { enabled: false }));
  await expect(device.action(api.githubJobs.refresh, { bindingId, jobId: 4 })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test("repository scans recover unknown jobs and recheck access before each page is saved", async () => {
  const { device, bindingId, t, fetch, machineId } = await fixture();
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("Missing test fetch");
  let removed = false;
  fetch.mockImplementation(async (url) => {
    if (url.includes("/actions/runs?"))
      return Response.json({ total_count: 1, workflow_runs: [{ id: 5 }] });
    if (url.includes("/actions/runs/5/jobs?")) {
      if (removed) await t.run(async (ctx) => ctx.db.delete("machines", machineId));
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 4,
            run_id: 5,
            name: "Build",
            status: "queued",
            conclusion: null,
            labels: ["vectis-mac"],
            runner_id: null,
            runner_name: null,
          },
        ],
      });
    }
    return original(url);
  });
  expect(await device.action(api.githubJobs.scan, { bindingId })).toEqual({
    runs: 1,
    jobs: 1,
    complete: true,
  });
  expect(await device.query(api.jobs.list, { bindingId })).toMatchObject([
    { jobId: 4, status: "queued" },
  ]);
  removed = true;
  await expect(device.action(api.githubJobs.scan, { bindingId })).rejects.toThrow();
});

test("repository scans reject disabled access before requesting GitHub", async () => {
  const { device, bindingId, t, fetch } = await fixture();
  await t.run(async (ctx) => ctx.db.patch("repositoryBindings", bindingId, { enabled: false }));
  await expect(device.action(api.githubJobs.scan, { bindingId })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test("refresh returns the merged stored job when an API response trails a completed webhook", async () => {
  const { device, bindingId, fetch } = await fixture();
  const completed = {
    id: 4,
    run_id: 5,
    name: "Build",
    status: "completed" as const,
    conclusion: "failure",
    labels: ["vectis-mac"],
    runner_id: 6,
    runner_name: "vectis-test",
  };
  await device.mutation(internal.jobs.save, {
    bindingId,
    installationId: 3,
    repositoryId: 2,
    job: completed,
  });
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("Missing test fetch");
  fetch.mockImplementation(async (url) =>
    url.endsWith("/actions/jobs/4")
      ? Response.json({
          ...completed,
          status: "queued",
          conclusion: null,
          runner_id: null,
          runner_name: null,
          html_url: "https://github.com/owner/sandbox/actions/runs/5/job/4",
          workflow_name: "CI",
        })
      : original(url),
  );
  const result = await device.action(api.githubJobs.refresh, { bindingId, jobId: 4 });
  expect(result).toEqual((await device.query(api.jobs.list, { bindingId }))[0]);
  expect(result).toMatchObject({
    jobId: 4,
    runId: 5,
    name: "Build",
    status: "completed",
    conclusion: "failure",
    runnerId: 6,
    runnerName: "vectis-test",
    workflowName: "CI",
    htmlUrl: "https://github.com/owner/sandbox/actions/runs/5/job/4",
  });
});

test.each(["refresh", "scan", "webhook"])(
  "%s stores REST run actor IDs only for restrictive repositories",
  async (surface) => {
    const { t, device, bindingId, fetch } = await fixture();
    const original = fetch.getMockImplementation();
    if (!original) throw new Error("Missing fetch");
    const job = {
      id: 4,
      run_id: 5,
      run_attempt: 1,
      name: "Build",
      status: "queued",
      conclusion: null,
      labels: ["vectis-mac"],
    };
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/actions/jobs/4")) return Response.json(job);
      if (url.includes("/actions/runs?"))
        return Response.json({ total_count: 1, workflow_runs: [{ id: 5 }] });
      if (url.includes("/actions/runs/5/jobs?"))
        return Response.json({ total_count: 1, jobs: [job] });
      if (url.endsWith("/actions/runs/5"))
        return Response.json({
          id: 5,
          run_attempt: 1,
          repository: { id: 2 },
          actor: { id: 7 },
          triggering_actor: { id: 8 },
        });
      return original(url);
    });
    vi.useFakeTimers();
    const request = async (delivery: string) => {
      if (surface === "refresh")
        return device.action(api.githubJobs.refresh, { bindingId, jobId: 4 });
      if (surface === "scan") return device.action(api.githubJobs.scan, { bindingId });
      const body = JSON.stringify({
        installation: { id: 3 },
        repository: { id: 2 },
        workflow_job: { ...job, actor_id: 999, triggering_actor_id: 999 },
      });
      const response = await t.fetch("/github/webhook", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", "test").update(body).digest("hex")}`,
        },
      });
      expect(response.status).toBe(202);
      return response;
    };
    await request("unrestricted");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/actions/runs/5"))).toBe(false);
    expect(await device.query(api.jobs.list, { bindingId })).toMatchObject([{ jobId: 4 }]);
    await t.run((ctx) =>
      ctx.db.patch("repositoryBindings", bindingId, {
        access: { actors: { ids: [7, 8] }, approval: "required" },
      }),
    );
    await request("restrictive");
    if (surface === "webhook")
      expect(await device.query(api.jobs.list, { bindingId })).toMatchObject([
        { access: "actor_unknown" },
      ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(1);
    expect(await device.query(api.jobs.list, { bindingId })).toMatchObject([
      { actorId: 7, triggeringActorId: 8, runAttempt: 1, access: "approval_required" },
    ]);
  },
);
