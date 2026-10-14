import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
const modules = {
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
      localId: "test",
      name: "Test",
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
      environmentId: "linux",
      enabled: true,
      verifiedAt: 1,
    });
    await ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 7,
      clientId: "client",
      privateKey,
      clientSecret: "unused",
      webhookSecret: "unused",
    });
    return { machineId, bindingId };
  });
  const state = {
    jobId: 4,
    runRepositoryId: 2,
    installationId: 3,
    status: "completed",
    logStatus: 302,
    beforeBlob: async () => {},
  };
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/installation"))
      return Response.json({
        id: state.installationId,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (path.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [2],
        permissions: { actions: "read", metadata: "read" },
      });
      return Response.json({ token: "test-secret" });
    }
    if (path.endsWith("/actions/jobs/4"))
      return Response.json({
        id: state.jobId,
        run_id: 5,
        name: "Build",
        status: state.status,
        conclusion: state.status === "completed" ? "failure" : null,
        labels: [],
      });
    if (path.endsWith("/actions/runs/5"))
      return Response.json({ id: 5, repository: { id: state.runRepositoryId } });
    if (path.endsWith("/logs"))
      return new Response(null, {
        status: state.logStatus,
        headers: { Location: "https://results-receiver.actions.githubusercontent.com/download" },
      });
    if (path.startsWith("https://results-receiver.")) {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      await state.beforeBlob();
      return new Response("failure: ***\n");
    }
    return Response.json({ id: 2, private: true, owner: { id: 7 } });
  });
  vi.stubGlobal("fetch", fetch);
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  return { t, device, bindingId, machineId, fetch, state };
}

test("authorized logs use read-only permissions and are never saved in cloud tables", async () => {
  const { device, bindingId, t } = await fixture();
  expect(await device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).toEqual({
    text: "failure: ***\n",
    next: 13,
    status: "completed",
    complete: true,
    truncated: false,
  });
  expect(await t.run((ctx) => ctx.db.query("githubJobs").collect())).toEqual([]);
});

test.each(["owner", "enabled"] as const)(
  "rejects a foreign or disabled binding before GitHub access: %s",
  async (field) => {
    const { device, bindingId, t, fetch } = await fixture();
    await t.run((ctx) =>
      ctx.db.patch(
        "repositoryBindings",
        bindingId,
        field === "owner" ? { owner: "other-owner" } : { enabled: false },
      ),
    );
    await expect(device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).rejects.toThrow(
      /repository_access_denied/,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(["runRepositoryId", "jobId", "installationId"] as const)(
  "rejects mismatched GitHub authority before downloading logs: %s",
  async (field) => {
    const { device, bindingId, fetch, state } = await fixture();
    state[field] = 99;
    await expect(device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).rejects.toThrow();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  },
);

test("revoking access during the download prevents returning the log", async () => {
  const { device, bindingId, t, state } = await fixture();
  state.beforeBlob = async () => {
    await t.run((ctx) => ctx.db.patch("repositoryBindings", bindingId, { enabled: false }));
  };
  await expect(device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).rejects.toThrow(
    /repository_access_denied/,
  );
});

test("running logs unavailable on GitHub wait honestly, while completed unavailable logs report an error", async () => {
  const { device, bindingId, state } = await fixture();
  state.status = "in_progress";
  state.logStatus = 404;
  expect(await device.action(api.githubJobs.logs, { bindingId, jobId: 4, after: 12 })).toEqual({
    text: "",
    next: 12,
    status: "in_progress",
    complete: false,
    truncated: false,
  });
  state.status = "completed";
  await expect(device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).rejects.toThrow(
    /job_logs_unavailable/,
  );
});

test("running jobs with available logs reach EOF without reporting completion", async () => {
  const { device, bindingId, state } = await fixture();
  state.status = "in_progress";
  expect(await device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).toMatchObject({
    next: 13,
    complete: false,
    status: "in_progress",
  });
});

test("readiness failures and invalid byte cursors are coded", async () => {
  const { device, bindingId, fetch } = await fixture();
  await expect(
    device.action(api.githubJobs.logs, { bindingId, jobId: 4, after: -1 }),
  ).rejects.toThrow(/invalid_job_log_request/);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockImplementation(async () => new Response(null, { status: 404 }));
  await expect(device.action(api.githubJobs.logs, { bindingId, jobId: 4 })).rejects.toThrow(
    /github_app_not_installed/,
  );
});
