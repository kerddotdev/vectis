import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
import { runnerLabels } from "../../packages/github/src/runner-labels.js";
import type { Doc } from "../../convex/_generated/dataModel.js";

const modules = {
  "../../convex/githubScaleSets.ts": () => import("../../convex/githubScaleSets.js"),
  "../../convex/runnerScaleSets.ts": () => import("../../convex/runnerScaleSets.js"),
  "../../convex/githubRunners.ts": () => import("../../convex/githubRunners.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/repositoryBindings.ts": () => import("../../convex/repositoryBindings.js"),
  "../../convex/purge.ts": () => import("../../convex/purge.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const serviceUrl = "https://actions.example.test/tenant/repository/";
const jwt = (exp: number) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machine.test");
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test");
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("githubAccounts", {
      owner: "owner",
      githubId: 71,
      login: "owner",
      installations: [],
      verifiedAt: 1,
    });
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "host",
      name: "Host",
      createdAt: 1,
      environments: [
        { id: "linux", name: "Linux", os: "linux", cpu: 2, memoryMiB: 4096, state: "ready" },
      ],
    });
    const foreignId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "foreign",
      name: "Foreign",
      createdAt: 1,
    });
    const bindingId = await ctx.db.insert("repositoryBindings", {
      owner: "owner",
      accountId,
      machineId,
      repositoryId: 600,
      repositoryName: "sandbox",
      installationId: 81,
      environmentId: "linux",
      enabled: true,
      automatic: true,
      verifiedAt: 1,
    });
    await ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 71,
      clientId: "client",
      privateKey,
      clientSecret: "test",
      webhookSecret: "test",
    });
    return { accountId, machineId, foreignId, bindingId };
  });
  let set:
    | {
        id: number;
        name: string;
        runnerGroupId: number;
        labels: Array<{ name: string; type: string }>;
      }
    | undefined;
  let sessionId: string | undefined;
  let nextSession = 0;
  let runnerName = "";
  const queueToken = jwt(Math.floor(Date.now() / 1000) + 3600);
  const adminToken = jwt(Math.floor(Date.now() / 1000) + 600);
  const state = {
    conflict: false,
    dropLabels: false,
    failDelete: 0,
    installationId: 81,
    repositoryId: 600,
    onSession: undefined as (() => Promise<unknown>) | undefined,
    onJit: undefined as (() => Promise<unknown>) | undefined,
    mismatchedRunner: false,
    wrongRepositoryRunner: false,
    failRefresh: 0,
  };
  const session = () => ({
    sessionId,
    messageQueueUrl: "https://queue.example.test/messages",
    messageQueueAccessToken: queueToken,
    statistics: { totalAssignedJobs: 2 },
  });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const path = url.pathname;
    if (url.hostname === "api.github.com") {
      if (path.endsWith("/installation"))
        return Response.json({
          id: state.installationId,
          app_id: 42,
          account: { id: 71, type: "User" },
          suspended_at: null,
        });
      if (path.endsWith("/access_tokens")) return Response.json({ token: "installation-secret" });
      if (path.endsWith("/fork-pr-workflows-private-repos"))
        return Response.json({
          run_workflows_from_fork_pull_requests: false,
          require_approval_for_fork_pr_workflows: false,
        });
      if (path.endsWith("/registration-token"))
        return Response.json({ token: "registration-secret" }, { status: 201 });
      if (path === "/actions/runner-registration") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "RemoteAuth registration-secret",
        );
        return Response.json({ url: serviceUrl, token: adminToken });
      }
      if (path.endsWith("/actions/runners/501"))
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              id: 501,
              name: state.wrongRepositoryRunner ? "foreign" : runnerName,
              status: "online",
              busy: false,
            });
      if (path === "/repos/owner/sandbox")
        return Response.json({ id: state.repositoryId, private: true, owner: { id: 71 } });
    }
    if (url.hostname !== "actions.example.test")
      throw new Error(`Unexpected synthetic request ${url.href}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${adminToken}`);
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/runnergroups/"))
      return Response.json({
        count: 1,
        value: [{ id: 42, name: "Default", isDefaultGroup: true }],
      });
    if (path.endsWith("/runnerscalesets")) {
      if (init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        if (!body || typeof body !== "object" || !("name" in body) || !("labels" in body))
          throw new Error("Invalid set request");
        const labels = runnerLabels("linux", "linux");
        expect(body.labels).toEqual(
          [...labels, body.name].map((name) => ({ name, type: "System" })),
        );
        set = {
          id: 17,
          name: String(body.name),
          runnerGroupId: 42,
          labels: [...labels, String(body.name)].map((name) => ({ name, type: "System" })),
        };
        return Response.json(set);
      }
      return Response.json({ count: set ? 1 : 0, value: set ? [set] : [] });
    }
    if (path.endsWith("/runnerscalesets/17")) {
      if (init?.method === "DELETE") {
        if (state.failDelete-- > 0) return new Response(null, { status: 503 });
        set = undefined;
        sessionId = undefined;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        ...set,
        labels: state.dropLabels ? [{ name: set?.name, type: "System" }] : set?.labels,
      });
    }
    if (path.endsWith("/sessions")) {
      if (state.conflict || sessionId) return new Response(null, { status: 409 });
      sessionId = `c6400b58-622b-497d-9c97-${String(++nextSession).padStart(12, "0")}`;
      await state.onSession?.();
      return Response.json(session());
    }
    if (path.includes("/sessions/")) {
      if (path.split("/").at(-1) !== sessionId) return new Response(null, { status: 404 });
      if (init?.method === "DELETE") {
        sessionId = undefined;
        return new Response(null, { status: 204 });
      }
      if (state.failRefresh-- > 0)
        return new Response("queue-secret admin-secret", { status: 503 });
      return Response.json(session());
    }
    if (path.endsWith("/generatejitconfig")) {
      const body: { name: string; workFolder: string } = JSON.parse(String(init?.body));
      runnerName = body.name;
      expect(body.workFolder).toBe("_work");
      await state.onJit?.();
      return Response.json({
        runner: { id: 501, name: state.mismatchedRunner ? "foreign" : runnerName },
        encodedJITConfig: "c2VjcmV0",
      });
    }
    throw new Error(`Unexpected synthetic request ${url.href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: ids.machineId,
    credentialVersion: 0,
  });
  const foreign = t.withIdentity({
    issuer: "https://machine.test",
    subject: ids.foreignId,
    credentialVersion: 0,
  });
  const owner = t.withIdentity({
    issuer: "https://clerk.test",
    subject: "owner",
    tokenIdentifier: "owner",
  });
  const enable = () =>
    device.mutation(api.repositoryBindings.setCapacityModeForMachine, {
      bindingId: ids.bindingId,
      capacityMode: "scale_set",
    });
  const open = () => device.action(api.githubScaleSets.open, { bindingId: ids.bindingId });
  const rows = () => t.run((ctx) => ctx.db.query("runnerScaleSets").collect());
  const requests = (suffix: string, method?: string) =>
    fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname.endsWith(suffix) && (method === undefined || init?.method === method);
    });
  return {
    t,
    ...ids,
    device,
    foreign,
    owner,
    enable,
    open,
    rows,
    requests,
    fetchMock,
    state,
    queueToken,
    adminToken,
  };
}

test("capacity mode defaults to demand and only the binding's machine can change it", async () => {
  const f = await fixture();
  expect(await f.device.query(api.repositoryBindings.forMachine, {})).toMatchObject([
    { capacityMode: "demand" },
  ]);
  const args = { bindingId: f.bindingId, capacityMode: "scale_set" as const };
  await expect(
    f.foreign.mutation(api.repositoryBindings.setCapacityModeForMachine, args),
  ).rejects.toThrow("repository_access_denied");
  await expect(
    f.owner.mutation(api.repositoryBindings.setCapacityModeForMachine, args),
  ).rejects.toThrow("machine_unauthorized");
  await f.enable();
  expect(await f.device.query(api.repositoryBindings.forMachine, {})).toMatchObject([
    { capacityMode: "scale_set" },
  ]);
  await f.t.run((ctx) => ctx.db.patch("githubAccounts", f.accountId, { owner: "foreign" }));
  await expect(f.enable()).rejects.toThrow("repository_access_denied");
  expect(f.fetchMock).not.toHaveBeenCalled();
});

test("open verifies custom labels, returns only a queue grant and persists no credentials", async () => {
  const f = await fixture();
  await f.enable();
  const grant = await f.open();
  expect(grant).toMatchObject({
    bindingId: f.bindingId,
    scaleSetId: 17,
    generation: 1,
    sessionId: "c6400b58-622b-497d-9c97-000000000001",
    messageQueueAccessToken: f.queueToken,
    statistics: { totalAssignedJobs: 2 },
  });
  expect(grant.queueTokenExpiresAt).toBeGreaterThan(Date.now());
  expect(grant.scaleSetName).toBe(`vectis-linux-${f.machineId.slice(0, 8)}`);
  const rows = await f.rows();
  expect(rows).toMatchObject([
    {
      phase: "active",
      scaleSetId: 17,
      generation: 1,
      sessionId: "c6400b58-622b-497d-9c97-000000000001",
    },
  ]);
  for (const secret of [f.queueToken, f.adminToken, "installation-secret", "registration-secret"])
    expect(JSON.stringify(rows)).not.toContain(secret);
  expect(JSON.stringify(grant)).not.toContain(f.adminToken);
  expect(f.requests("/runnerscalesets", "POST")).toHaveLength(1);
});

test("second open deletes the stored session, reuses the set and fences old refresh and close", async () => {
  const f = await fixture();
  await f.enable();
  const first = await f.open();
  const second = await f.open();
  expect(second).toMatchObject({
    generation: 2,
    sessionId: "c6400b58-622b-497d-9c97-000000000002",
    scaleSetId: first.scaleSetId,
  });
  expect(f.requests("/sessions/c6400b58-622b-497d-9c97-000000000001", "DELETE")).toHaveLength(1);
  expect(f.requests("/runnerscalesets", "POST")).toHaveLength(1);
  const calls = f.fetchMock.mock.calls.length;
  for (const action of [api.githubScaleSets.refresh, api.githubScaleSets.close])
    await expect(
      f.device.action(action, { bindingId: f.bindingId, generation: first.generation }),
    ).rejects.toThrow("scale_set_superseded");
  expect(f.fetchMock).toHaveBeenCalledTimes(calls);
  expect(
    await f.device.action(api.githubScaleSets.refresh, {
      bindingId: f.bindingId,
      generation: second.generation,
    }),
  ).toMatchObject({ generation: 2, sessionId: "c6400b58-622b-497d-9c97-000000000002" });
  await f.device.action(api.githubScaleSets.close, {
    bindingId: f.bindingId,
    generation: second.generation,
  });
  await f.device.action(api.githubScaleSets.close, {
    bindingId: f.bindingId,
    generation: second.generation,
  });
  expect(f.requests("/sessions/c6400b58-622b-497d-9c97-000000000002", "DELETE")).toHaveLength(1);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(0);
  expect(await f.rows()).toMatchObject([{ phase: "closed", generation: 2 }]);
  expect((await f.rows())[0]?.sessionId).toBeUndefined();
  expect(await f.open()).toMatchObject({ generation: 3 });
});

test("unknown session conflict is typed and never retried", async () => {
  const f = await fixture();
  await f.enable();
  f.state.conflict = true;
  await expect(f.open()).rejects.toThrow("scale_set_session_conflict");
  expect(f.requests("/sessions", "POST")).toHaveLength(1);
  expect(await f.rows()).toMatchObject([{ phase: "action_required", generation: 1 }]);
});

test("dropped labels fail honestly before creating a session", async () => {
  const f = await fixture();
  await f.enable();
  f.state.dropLabels = true;
  await expect(f.open()).rejects.toThrow("scale_set_labels_unsupported");
  expect(f.requests("/sessions", "POST")).toHaveLength(0);
});

test("unauthorized, disabled, nonautomatic and demand bindings cannot open", async () => {
  const f = await fixture();
  await expect(f.open()).rejects.toThrow("scale_set_disabled");
  await f.enable();
  await expect(
    f.foreign.action(api.githubScaleSets.open, { bindingId: f.bindingId }),
  ).rejects.toThrow("repository_access_denied");
  await expect(
    f.owner.action(api.githubScaleSets.open, { bindingId: f.bindingId }),
  ).rejects.toThrow("machine_unauthorized");
  await f.t.run((ctx) => ctx.db.patch("repositoryBindings", f.bindingId, { automatic: false }));
  await expect(f.open()).rejects.toThrow("automatic_disabled");
  await f.t.run((ctx) =>
    ctx.db.patch("repositoryBindings", f.bindingId, { automatic: true, enabled: false }),
  );
  await expect(f.open()).rejects.toThrow("repository_access_denied");
  expect(f.fetchMock).not.toHaveBeenCalled();
});

test.each(["installationId", "repositoryId"] as const)(
  "open verifies current %s before scale set effects",
  async (field) => {
    const f = await fixture();
    await f.enable();
    f.state[field]++;
    await expect(f.open()).rejects.toThrow(
      field === "installationId" ? "installation_changed" : "repository_access_denied",
    );
    expect(f.requests("/runnerscalesets", "POST")).toHaveLength(0);
  },
);

const restricted: NonNullable<Doc<"repositoryBindings">["access"]>[] = [
  { actors: { ids: [71] }, approval: "automatic" },
  { actors: "any", approval: "required" },
];
test.each(restricted)("restricted policy refuses mode, open and prepare: %j", async (access) => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch("repositoryBindings", f.bindingId, { access }));
  await expect(f.enable()).rejects.toThrow("scale_set_policy_unsupported");
  await f.t.run((ctx) =>
    ctx.db.patch("repositoryBindings", f.bindingId, { capacityMode: "scale_set" }),
  );
  await expect(f.open()).rejects.toThrow("scale_set_policy_unsupported");
  await expect(
    f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "restricted",
      scaleSet: { generation: 1 },
    }),
  ).rejects.toThrow("scale_set_policy_unsupported");
  expect(f.fetchMock).not.toHaveBeenCalled();
});

test("access cannot become restrictive while scale set mode is enabled", async () => {
  const f = await fixture();
  await f.enable();
  await expect(
    f.device.mutation(api.repositoryBindings.setAccess, {
      bindingId: f.bindingId,
      actors: "any",
      approval: "required",
    }),
  ).rejects.toThrow("scale_set_policy_unsupported");
});

test.each([false, true])(
  "scale set JIT (cacheEnabled=%s) preserves lease identity, denies cache writes and cleans up",
  async (cacheEnabled) => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("repositoryBindings", f.bindingId, {
        cacheVolume: { enabled: cacheEnabled, sizeGiB: 20 },
      }),
    );
    await f.enable();
    const session = await f.open();
    const args = {
      bindingId: f.bindingId,
      key: "jit",
      automatic: true,
      scaleSet: { generation: session.generation },
    };
    const grant = await f.device.action(api.githubRunners.prepare, args);
    expect(grant).toMatchObject({
      state: "ready",
      runnerId: 501,
      encodedConfig: "c2VjcmV0",
      cacheWrite: false,
      os: "linux",
      environmentId: "linux",
    });
    expect(await f.device.action(api.githubRunners.prepare, args)).toEqual(grant);
    expect(f.requests("/generatejitconfig", "POST")).toHaveLength(1);
    expect(f.requests("/generate-jitconfig", "POST")).toHaveLength(0);
    expect(await f.t.run((ctx) => ctx.db.query("runnerLeases").unique())).toMatchObject({
      phase: "ready",
      runnerId: 501,
      scaleSet: { generation: 1 },
      cacheWrite: false,
    });
    const lease = await f.t.run((ctx) => ctx.db.query("runnerLeases").unique());
    expect(lease?.jobId).toBeUndefined();
    expect(lease?.cacheRun).toBeUndefined();
    expect(grant).not.toHaveProperty("access.cacheRun");
    expect(await f.device.action(api.githubRunners.status, { id: grant.id })).toEqual({
      busy: false,
      status: "online",
    });
    await f.device.action(api.githubRunners.release, { id: grant.id });
    expect(f.requests("/actions/runners/501", "DELETE")).toHaveLength(1);
  },
);

test("stale scale set JIT and job-specific requests are refused before registration", async () => {
  const f = await fixture();
  await f.enable();
  await f.open();
  await f.open();
  await expect(
    f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "old",
      scaleSet: { generation: 1 },
    }),
  ).rejects.toThrow("scale_set_superseded");
  await expect(
    f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "job",
      jobId: 4,
      scaleSet: { generation: 2 },
    }),
  ).rejects.toThrow("invalid_runner_request");
  await expect(
    f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "no-generation",
      automatic: true,
    }),
  ).rejects.toThrow("scale_set_generation_required");
  expect(f.requests("/generatejitconfig", "POST")).toHaveLength(0);
  expect(await f.t.run((ctx) => ctx.db.query("runnerLeases").collect())).toHaveLength(0);
});

test("a newer session during JIT fences the grant but preserves runner cleanup", async () => {
  const f = await fixture();
  await f.enable();
  await f.open();
  f.state.onJit = () => f.open();
  const grant = await f.device.action(api.githubRunners.prepare, {
    bindingId: f.bindingId,
    key: "raced",
    scaleSet: { generation: 1 },
  });
  expect(grant.state).toBe("action_required");
  expect(await f.t.run((ctx) => ctx.db.query("runnerLeases").unique())).toMatchObject({
    runnerId: 501,
    phase: "action_required",
  });
  expect(
    (await f.t.run((ctx) => ctx.db.query("runnerLeases").unique()))?.encodedConfig,
  ).toBeUndefined();
  await f.device.action(api.githubRunners.release, { id: grant.id });
  expect(f.requests("/actions/runners/501", "DELETE")).toHaveLength(1);
});

test.each(["demand", "disconnect", "disable"] as const)(
  "%s fences the listener and schedules set cleanup with retries",
  async (change) => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.enable();
    const session = await f.open();
    f.state.failDelete = 1;
    if (change === "demand")
      await f.device.mutation(api.repositoryBindings.setCapacityModeForMachine, {
        bindingId: f.bindingId,
        capacityMode: "demand",
      });
    if (change === "disconnect")
      await f.device.mutation(api.repositoryBindings.disconnectForMachine, {
        bindingId: f.bindingId,
      });
    if (change === "disable")
      await f.owner.mutation(api.repositoryBindings.disable, { id: f.bindingId });
    expect(await f.rows()).toMatchObject([{ phase: "deleting", generation: 2 }]);
    await expect(
      f.device.action(api.githubScaleSets.close, {
        bindingId: f.bindingId,
        generation: session.generation,
      }),
    ).rejects.toThrow("scale_set_superseded");
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(2);
    expect(await f.rows()).toMatchObject([{ phase: "closed", generation: 2 }]);
    expect((await f.rows())[0]?.sessionId).toBeUndefined();
    expect((await f.rows())[0]?.scaleSetId).toBeUndefined();
    if (change === "demand") {
      await f.enable();
      expect(await f.open()).toMatchObject({ generation: 3 });
    }
  },
);

test("mode change during session creation returns no grant and cleans up remote effects", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.enable();
  f.state.onSession = () =>
    f.device.mutation(api.repositoryBindings.setCapacityModeForMachine, {
      bindingId: f.bindingId,
      capacityMode: "demand",
    });
  await expect(f.open()).rejects.toThrow("scale_set_superseded");
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.requests("/sessions/c6400b58-622b-497d-9c97-000000000001", "DELETE")).toHaveLength(1);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(1);
});

test("binding purge retains enough verified metadata to clean up after account removal", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.enable();
  await f.open();
  await f.t.mutation(internal.purge.binding, { bindingId: f.bindingId });
  await f.t.run((ctx) => ctx.db.delete("githubAccounts", f.accountId));
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(1);
  expect(await f.rows()).toEqual([]);
});

test("an in-flight open serializes session effects instead of opening a competing session", async () => {
  const f = await fixture();
  await f.enable();
  f.state.onSession = async () => {
    await expect(f.open()).rejects.toThrow("scale_set_pending");
  };
  expect(await f.open()).toMatchObject({ generation: 1 });
  expect(f.requests("/sessions", "POST")).toHaveLength(1);
  expect(await f.rows()).toMatchObject([{ phase: "active", generation: 1 }]);
});

test("a failed refresh preserves the known session for a current-generation retry", async () => {
  const f = await fixture();
  await f.enable();
  const first = await f.open();
  f.state.failRefresh = 1;
  const args = { bindingId: f.bindingId, generation: first.generation };
  await expect(f.device.action(api.githubScaleSets.refresh, args)).rejects.toThrow(
    "scale_set_unavailable",
  );
  expect(await f.rows()).toMatchObject([{ phase: "action_required", sessionId: first.sessionId }]);
  expect(await f.device.action(api.githubScaleSets.refresh, args)).toMatchObject({
    sessionId: first.sessionId,
  });
});

test("the scale set runner id must resolve to the same lease in the repository runner API", async () => {
  const f = await fixture();
  await f.enable();
  await f.open();
  f.state.wrongRepositoryRunner = true;
  const grant = await f.device.action(api.githubRunners.prepare, {
    bindingId: f.bindingId,
    key: "identity",
    scaleSet: { generation: 1 },
  });
  expect(grant.state).toBe("action_required");
  expect(
    (await f.t.run((ctx) => ctx.db.query("runnerLeases").unique()))?.encodedConfig,
  ).toBeUndefined();
  await expect(f.device.action(api.githubRunners.release, { id: grant.id })).rejects.toThrow(
    "runner_identity_conflict",
  );
  expect(f.requests("/actions/runners/501", "DELETE")).toHaveLength(0);
});

test("cleanup has a bounded retry budget and a later demand-mode request can retry it", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.enable();
  await f.open();
  f.state.failDelete = 8;
  const args = { bindingId: f.bindingId, capacityMode: "demand" as const };
  await f.device.mutation(api.repositoryBindings.setCapacityModeForMachine, args);
  await f.device.mutation(api.repositoryBindings.setCapacityModeForMachine, args);
  expect(await f.rows()).toMatchObject([{ phase: "deleting", generation: 2 }]);
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(8);
  expect(await f.rows()).toMatchObject([{ phase: "action_required", generation: 2 }]);
  await f.device.mutation(api.repositoryBindings.setCapacityModeForMachine, args);
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(9);
  expect(await f.rows()).toMatchObject([{ phase: "closed", generation: 3 }]);
});

test("JIT remains available while the current session is refreshing", async () => {
  const f = await fixture();
  await f.enable();
  await f.open();
  await f.device.mutation(internal.runnerScaleSets.begin, {
    bindingId: f.bindingId,
    generation: 1,
    operation: "refresh",
  });
  expect(
    await f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "refreshing",
      scaleSet: { generation: 1 },
    }),
  ).toMatchObject({ state: "ready" });
});

test("JIT refuses an existing set whose labels no longer match the binding environment", async () => {
  const f = await fixture();
  await f.enable();
  await f.open();
  f.state.dropLabels = true;
  expect(
    await f.device.action(api.githubRunners.prepare, {
      bindingId: f.bindingId,
      key: "labels",
      scaleSet: { generation: 1 },
    }),
  ).toMatchObject({ state: "action_required" });
  expect(f.requests("/generatejitconfig", "POST")).toHaveLength(0);
});

test("turning automatic capacity off refuses refresh but still lets the host close its session", async () => {
  const f = await fixture();
  await f.enable();
  const grant = await f.open();
  await f.device.mutation(api.repositoryBindings.setAutomatic, {
    bindingId: f.bindingId,
    enabled: false,
  });
  const args = { bindingId: f.bindingId, generation: grant.generation };
  await expect(f.device.action(api.githubScaleSets.refresh, args)).rejects.toThrow(
    "automatic_disabled",
  );
  await f.device.action(api.githubScaleSets.close, args);
  expect(await f.rows()).toMatchObject([{ phase: "closed", scaleSetId: 17 }]);
  expect(f.requests("/runnerscalesets/17", "DELETE")).toHaveLength(0);
});

test("a late session checkpoint or failure cannot resurrect a closed listener", async () => {
  const f = await fixture();
  await f.enable();
  const grant = await f.open();
  const row = (await f.rows())[0];
  if (!row) throw new Error("Missing scale set");
  const identity = { id: row._id, generation: grant.generation };
  await f.device.action(api.githubScaleSets.close, {
    bindingId: f.bindingId,
    generation: grant.generation,
  });
  await expect(
    f.device.mutation(internal.runnerScaleSets.checkpoint, {
      ...identity,
      sessionId: grant.sessionId,
      phase: "active",
    }),
  ).rejects.toThrow("scale_set_superseded");
  await f.t.mutation(internal.runnerScaleSets.failed, identity);
  expect(await f.rows()).toMatchObject([{ phase: "closed", generation: grant.generation }]);
  expect((await f.rows())[0]?.sessionId).toBeUndefined();
});
