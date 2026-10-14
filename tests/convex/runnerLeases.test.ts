import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/githubRunners.ts": () => import("../../convex/githubRunners.js"),
  "../../convex/repositoryBindings.ts": () => import("../../convex/repositoryBindings.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const identity = {
  issuer: "https://clerk.test",
  subject: "owner",
  tokenIdentifier: "https://clerk.test|owner",
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", identity.issuer);
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity);
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  await device.mutation(api.machines.heartbeat, {
    environments: [
      { id: "mac", name: "Mac", os: "macos", cpu: 2, memoryMiB: 4096, state: "ready" },
    ],
  });
  const accountId = await t.run(async (ctx) => {
    await ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 71,
      clientId: "client",
      privateKey: key,
      clientSecret: "test",
      webhookSecret: "test",
    });
    return ctx.db.insert("githubAccounts", {
      owner: identity.tokenIdentifier,
      githubId: 71,
      login: "owner",
      installations: [],
      verifiedAt: Date.now(),
    });
  });
  const bindingId = await t.mutation(internal.repositoryBindings.save, {
    owner: identity.tokenIdentifier,
    machineId,
    accountId,
    repositoryId: 600,
    repositoryName: "sandbox",
    installationId: 81,
    environmentId: "mac",
  });
  let name = "";
  let loseResponse = false;
  let onRegistration: (() => Promise<unknown>) | undefined;
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 81,
        app_id: 42,
        account: { id: 71, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "scoped-test-token" });
    if (url.endsWith("/fork-pr-workflows-private-repos"))
      return Response.json({
        run_workflows_from_fork_pull_requests: false,
        require_approval_for_fork_pr_workflows: false,
      });
    if (url.endsWith("/generate-jitconfig")) {
      const body = JSON.parse(String(init?.body));
      name = body.name;
      expect(body.labels).toEqual(["self-hosted", "macOS", "ARM64", "vectis-mac"]);
      await onRegistration?.();
      if (loseResponse) throw new Error("Response lost after registration");
      return Response.json({ runner: { id: 501, name }, encoded_jit_config: "c2VjcmV0" });
    }
    if (url.endsWith("/actions/runners/501"))
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: 501, name });
    if (url.includes("/actions/runners?"))
      return Response.json({
        total_count: 2,
        runners: [
          { id: 500, name: "foreign-runner" },
          { id: 501, name },
        ],
      });
    if (url === "https://api.github.com/repos/owner/sandbox")
      return Response.json({ id: 600, private: true, owner: { id: 71 } });
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", fetch);
  return {
    t,
    owner,
    device,
    machineId,
    bindingId,
    fetch,
    loseResponse: () => {
      loseResponse = true;
    },
    onRegistration: (callback: () => Promise<unknown>) => {
      onRegistration = callback;
    },
  };
}
test("runner grants deduplicate, hide credentials from discovery and release once", async () => {
  const { device, bindingId, fetch } = await fixture();
  const args = { bindingId, key: "start-once" };
  const first = await device.action(api.githubRunners.prepare, args);
  expect(first.state).toBe("ready");
  expect(await device.action(api.githubRunners.prepare, args)).toEqual(first);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/generate-jitconfig"))).toHaveLength(1);
  expect(JSON.stringify(await device.query(api.runnerLeases.list, {}))).not.toContain("c2VjcmV0");
  expect(await device.action(api.githubRunners.release, { id: first.id })).toMatchObject({
    state: "released",
  });
  await device.action(api.githubRunners.release, { id: first.id });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  expect(await device.action(api.githubRunners.prepare, args)).toEqual({
    state: "released",
    id: first.id,
  });
  expect(await device.query(api.runnerLeases.list, {})).toEqual([]);
});
test("lost registration responses require reconciliation instead of another registration", async () => {
  const { device, bindingId, fetch, loseResponse } = await fixture();
  loseResponse();
  const args = { bindingId, key: "lost-response" };
  const first = await device.action(api.githubRunners.prepare, args);
  expect(first.state).toBe("action_required");
  expect(await device.action(api.githubRunners.prepare, args)).toEqual(first);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/generate-jitconfig"))).toHaveLength(1);
  await device.action(api.githubRunners.release, { id: first.id });
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url),
  ).toEqual(["https://api.github.com/repos/owner/sandbox/actions/runners/501"]);
});
test("human, foreign and revoked identities cannot obtain machine grants", async () => {
  const { t, owner, device, machineId, bindingId, fetch } = await fixture();
  const args = { bindingId, key: "denied" };
  await expect(owner.action(api.githubRunners.prepare, args)).rejects.toThrow();
  const foreignId = await owner.mutation(api.machines.enroll, {
    localId: "second",
    name: "Second",
  });
  const foreign = t.withIdentity({
    issuer: "https://machine.test",
    subject: foreignId,
    credentialVersion: 0,
  });
  await expect(foreign.action(api.githubRunners.prepare, args)).rejects.toThrow();
  await owner.mutation(api.machines.remove, { id: machineId });
  await expect(device.action(api.githubRunners.prepare, args)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
test("a binding disabled during registration cannot receive credentials and can still be cleaned up", async () => {
  const { owner, device, bindingId, onRegistration } = await fixture();
  onRegistration(() => owner.mutation(api.repositoryBindings.disable, { id: bindingId }));
  const grant = await device.action(api.githubRunners.prepare, {
    bindingId,
    key: "revoked-binding",
  });
  expect(grant).toEqual({ state: "action_required", id: grant.id });
  await expect(
    device.action(api.githubRunners.prepare, { bindingId, key: "another" }),
  ).rejects.toThrow();
  expect(await device.action(api.githubRunners.release, { id: grant.id })).toMatchObject({
    state: "released",
  });
});

test("a private fork policy change blocks JIT registration after binding", async () => {
  const { device, bindingId, fetch } = await fixture();
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url, init) =>
    url.endsWith("/fork-pr-workflows-private-repos")
      ? Response.json({
          run_workflows_from_fork_pull_requests: true,
          require_approval_for_fork_pr_workflows: false,
        })
      : original(url, init),
  );
  await expect(
    device.action(api.githubRunners.prepare, { bindingId, key: "policy-change" }),
  ).rejects.toThrow("private_runner_approval_required");
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/generate-jitconfig"))).toBe(false);
});

test("access settings enforce machine, binding and account ownership and deduplicate actor IDs", async () => {
  const { t, device, bindingId, machineId } = await fixture();
  await device.mutation(api.repositoryBindings.setAccess, {
    bindingId,
    actors: { ids: [7, 7, 8] },
    approval: "required",
  });
  expect(await device.query(api.repositoryBindings.forMachine, {})).toMatchObject([
    { access: { actors: { ids: [7, 8] }, approval: "required" } },
  ]);
  for (const ids of [
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    Array.from({ length: 101 }, (_, i) => i + 1),
  ])
    await expect(
      device.mutation(api.repositoryBindings.setAccess, {
        bindingId,
        actors: { ids },
        approval: "automatic",
      }),
    ).rejects.toThrow("invalid_repository_access");
  const foreignId = await t.run((ctx) =>
    ctx.db.insert("machines", { owner: "other", localId: "other", name: "Other", createdAt: 1 }),
  );
  const foreign = t.withIdentity({
    issuer: "https://machine.test",
    subject: foreignId,
    credentialVersion: 0,
  });
  await expect(
    foreign.mutation(api.repositoryBindings.setAccess, {
      bindingId,
      actors: "any",
      approval: "automatic",
    }),
  ).rejects.toThrow("repository_access_denied");
  await t.run(async (ctx) => {
    const binding = await ctx.db.get("repositoryBindings", bindingId);
    if (!binding) throw new Error("Missing binding");
    await ctx.db.patch("githubAccounts", binding.accountId, { owner: "other" });
  });
  await expect(
    device.mutation(api.repositoryBindings.setAccess, {
      bindingId,
      actors: "any",
      approval: "automatic",
    }),
  ).rejects.toThrow("repository_access_denied");
  expect(await t.run((ctx) => ctx.db.get("machines", machineId))).not.toBeNull();
});

async function approvalFixture() {
  const fixtureResult = await fixture();
  const { t, bindingId } = fixtureResult;
  const jobDocumentId = await t.run(async (ctx) => {
    await ctx.db.patch("repositoryBindings", bindingId, {
      access: { actors: { ids: [7] }, approval: "required" },
      automatic: true,
    });
    return ctx.db.insert("githubJobs", {
      installationId: 81,
      repositoryId: 600,
      jobId: 4,
      runId: 5,
      runAttempt: 2,
      actorId: 7,
      triggeringActorId: 7,
      name: "Build",
      status: "queued",
      conclusion: null,
      labels: ["vectis-mac"],
      runnerId: null,
      runnerName: null,
      updatedAt: 1,
    });
  });
  return { ...fixtureResult, jobDocumentId };
}

test("manual job start approves precisely its run attempt and an automatic start cannot approve it", async () => {
  const { device, bindingId, fetch } = await approvalFixture();
  await expect(
    device.action(api.githubRunners.prepare, {
      bindingId,
      key: "automatic",
      jobId: 4,
      automatic: true,
    }),
  ).rejects.toThrow("approval_required");
  await expect(
    device.action(api.githubRunners.prepare, { bindingId, key: "no-job" }),
  ).rejects.toThrow("job_required");
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await device.action(api.githubRunners.prepare, { bindingId, key: "manual", jobId: 4 }),
  ).toMatchObject({
    state: "ready",
    access: {
      repositoryId: 600,
      actors: { ids: [7] },
      approval: "required",
      approvedRun: { runId: 5, runAttempt: 2 },
    },
  });
});

test.each(["actor", "triggering", "unknown"])(
  "manual approval still refuses a %s actor",
  async (which) => {
    const { device, bindingId, t, jobDocumentId, fetch } = await approvalFixture();
    await t.run((ctx) =>
      ctx.db.patch(
        "githubJobs",
        jobDocumentId,
        which === "actor"
          ? { actorId: 8 }
          : which === "triggering"
            ? { triggeringActorId: 8 }
            : { triggeringActorId: undefined },
      ),
    );
    await expect(
      device.action(api.githubRunners.prepare, { bindingId, key: "manual", jobId: 4 }),
    ).rejects.toThrow(which === "unknown" ? "actor_unknown" : "actor_not_allowed");
    expect(fetch).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("runnerLeases").collect())).toHaveLength(0);
  },
);

test("policy changes during JIT registration cannot return an outdated ready grant", async () => {
  const { device, bindingId, t, onRegistration } = await approvalFixture();
  onRegistration(() =>
    t.run((ctx) =>
      ctx.db.patch("repositoryBindings", bindingId, {
        access: { actors: { ids: [8] }, approval: "required" },
      }),
    ),
  );
  expect(
    await device.action(api.githubRunners.prepare, { bindingId, key: "changed", jobId: 4 }),
  ).toMatchObject({ state: "action_required" });
});
