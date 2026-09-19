import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/jobs.ts": () => import("../../convex/jobs.js"),
  "../../convex/githubJobs.ts": () => import("../../convex/githubJobs.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
afterEach(() => {
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
