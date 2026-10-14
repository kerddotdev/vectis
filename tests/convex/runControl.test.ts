import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
import { Service } from "../../apps/server/src/service.js";
import { Store } from "../../apps/server/src/store.js";
import { VmRuntime } from "../../packages/runner/src/runtime.js";
import {
  advanceRemoteOperation,
  type Acknowledgement,
} from "../../packages/client/src/remote-operation.js";
import type { RunControlCommand } from "../../packages/protocol/src/runs.js";

const modules = {
  "../../convex/githubRuns.ts": () => import("../../convex/githubRuns.js"),
  "../../convex/runReceipts.ts": () => import("../../convex/runReceipts.js"),
  "../../convex/runnerLeases.ts": () => import("../../convex/runnerLeases.js"),
  "../../convex/operations.ts": () => import("../../convex/operations.js"),
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
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test");
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
  const run = {
    id: 5,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/owner/sandbox/actions/runs/5",
    repository: { id: 2 },
  };
  let failedJobs = true;
  let beforePost: (() => Promise<void>) | undefined;
  let post: () => Promise<Response> = async () => {
    run.run_attempt++;
    run.status = "queued";
    return new Response(null, { status: 201 });
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 3,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "test-actions-token" });
    if (url.endsWith("/fork-pr-workflows-private-repos"))
      return Response.json({
        run_workflows_from_fork_pull_requests: false,
        require_approval_for_fork_pr_workflows: true,
      });
    if (url === "https://api.github.com/repos/owner/sandbox")
      return Response.json({ id: 2, private: true, owner: { id: 7 } });
    if (init?.method === "POST") {
      const receipts = await t.run((ctx) => ctx.db.query("runCommandReceipts").collect());
      expect(receipts.some((receipt) => receipt.state === "submitted")).toBe(true);
      await beforePost?.();
      return post();
    }
    if (url.includes("/jobs?"))
      return Response.json({
        total_count: 1,
        jobs: [{ conclusion: failedJobs ? "failure" : "success" }],
      });
    if (url.endsWith("/actions/runs/5")) return Response.json(run);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const device = t.withIdentity({
    issuer: "https://machine.test",
    subject: machineId,
    credentialVersion: 0,
  });
  const command = { type: "run.rerun-failed", bindingId, runId: 5 } as const;
  return {
    t,
    device,
    bindingId,
    machineId,
    command,
    run,
    fetch,
    posts: () =>
      fetch.mock.calls.filter(
        ([url, init]) => init?.method === "POST" && !url.endsWith("/access_tokens"),
      ),
    setPost: (callback: () => Promise<Response>) => {
      post = callback;
    },
    setBeforePost: (callback: () => Promise<void>) => {
      beforePost = callback;
    },
    setFailedJobs: (value: boolean) => {
      failedJobs = value;
    },
  };
}

test("a newer attempt confirms rerun and a stored receipt prevents a second POST", async () => {
  const f = await fixture();
  const outcome = await f.device.action(api.githubRuns.control, {
    key: "rerun",
    command: f.command,
  });
  expect(outcome).toMatchObject({
    state: "accepted",
    rerun: "observed",
    runId: 5,
    runAttempt: 2,
    htmlUrl: f.run.html_url,
  });
  expect(
    await f.device.action(api.githubRuns.control, { key: "rerun", command: f.command }),
  ).toEqual(outcome);
  expect(f.posts()).toHaveLength(1);
  expect(
    JSON.stringify(await f.t.run((ctx) => ctx.db.query("runCommandReceipts").collect())),
  ).not.toContain("test-actions-token");
  await expect(
    f.device.action(api.githubRuns.control, { key: "rerun", command: { ...f.command, runId: 6 } }),
  ).rejects.toThrow("idempotency_conflict");
});

test("another owner's binding is rejected before any GitHub request", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch("repositoryBindings", f.bindingId, { owner: "other" }));
  await expect(
    f.device.action(api.githubRuns.control, { key: "foreign", command: f.command }),
  ).rejects.toThrow("repository_access_denied");
  expect(f.fetch).not.toHaveBeenCalled();
});

test("a run from another repository is refused without POST", async () => {
  const f = await fixture();
  f.run.repository.id = 99;
  expect(
    await f.device.action(api.githubRuns.control, { key: "wrong-repo", command: f.command }),
  ).toMatchObject({ state: "rejected", code: "run_repository_mismatch" });
  expect(f.posts()).toHaveLength(0);
});

test.each([
  { type: "run.cancel", failure: "network" },
  { type: "run.cancel", failure: "server" },
  { type: "run.cancel", failure: "no-status" },
  { type: "run.rerun-failed", failure: "network" },
  { type: "run.rerun-failed", failure: "server" },
  { type: "run.rerun-failed", failure: "no-status" },
] as const)(
  "ambiguous $type $failure POST stays uncertain on replay",
  async ({ type, failure }) => {
    const f = await fixture();
    const command = { ...f.command, type };
    if (type === "run.cancel") f.run.status = "in_progress";
    f.setPost(async () => {
      if (failure === "no-status") return Response.error();
      if (failure === "network") throw new TypeError("Response lost after submission");
      return new Response("Unavailable", { status: 503 });
    });
    const outcome = await f.device.action(api.githubRuns.control, {
      key: "uncertain",
      command,
    });
    expect(outcome).toMatchObject({
      state: "uncertain",
      code: "run_command_unconfirmed",
      nextStep: expect.stringContaining("Check the run on GitHub"),
    });
    expect(await f.device.action(api.githubRuns.control, { key: "uncertain", command })).toEqual(
      outcome,
    );
    expect(f.posts()).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("runCommandReceipts").unique())).toMatchObject({
      state: "uncertain",
    });
  },
);

test("an in-flight receipt prevents concurrent POSTs and a crash receipt never resubmits", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setBeforePost(() => waiting);
  const first = f.device.action(api.githubRuns.control, { key: "concurrent", command: f.command });
  await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(
    await f.device.action(api.githubRuns.control, { key: "concurrent", command: f.command }),
  ).toMatchObject({ state: "uncertain", code: "run_command_unconfirmed" });
  release();
  expect(await first).toMatchObject({ state: "accepted" });
  const receipt = await f.t.run((ctx) => ctx.db.query("runCommandReceipts").unique());
  if (!receipt) throw new Error("Missing receipt");
  await f.t.run((ctx) =>
    ctx.db.patch("runCommandReceipts", receipt._id, { state: "submitted", outcome: undefined }),
  );
  expect(
    await f.device.action(api.githubRuns.control, { key: "concurrent", command: f.command }),
  ).toMatchObject({ state: "uncertain" });
  expect(f.posts()).toHaveLength(1);
});

test.each(["completed-cancel", "running-rerun", "no-failed-jobs"])(
  "refuses %s without submission",
  async (scenario) => {
    const f = await fixture();
    const command: RunControlCommand =
      scenario === "completed-cancel" ? { ...f.command, type: "run.cancel" } : f.command;
    if (scenario === "running-rerun") f.run.status = "in_progress";
    if (scenario === "no-failed-jobs") f.setFailedJobs(false);
    expect(
      await f.device.action(api.githubRuns.control, { key: "refused", command }),
    ).toMatchObject({
      state: "rejected",
      code: scenario === "completed-cancel" ? "run_not_active" : "run_not_rerunnable",
    });
    expect(f.posts()).toHaveLength(0);
  },
);

test.each(["completed", "cancelled"])(
  "202 cancellation observes a delayed %s state without resubmitting",
  async (status) => {
    vi.useFakeTimers();
    const f = await fixture();
    f.run.status = "in_progress";
    f.setPost(async () => new Response(null, { status: 202 }));
    const command = { ...f.command, type: "run.cancel" } as const;
    const pending = f.device.action(api.githubRuns.control, { key: "cancel", command });
    await vi.waitFor(() =>
      expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(2),
    );
    f.run.status = status;
    f.run.conclusion = "cancelled";
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      state: "accepted",
      cancellation: "observed",
      runId: 5,
      runAttempt: 1,
    });
    expect(await f.device.action(api.githubRuns.control, { key: "cancel", command })).toEqual(
      outcome,
    );
    expect(f.posts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(["in_progress", "cancelling"])(
  "202 cancellation still %s after 20 seconds is requested, not uncertain",
  async (status) => {
    vi.useFakeTimers();
    const f = await fixture();
    f.run.status = "in_progress";
    f.setPost(async () => {
      f.run.status = status;
      return new Response(null, { status: 202 });
    });
    const command = { ...f.command, type: "run.cancel" } as const;
    const pending = f.device.action(api.githubRuns.control, { key: "cancel-requested", command });
    await vi.waitFor(() =>
      expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(2),
    );
    await vi.advanceTimersByTimeAsync(20000);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      state: "accepted",
      cancellation: "requested",
      message: "GitHub accepted the cancellation; the run is still stopping.",
      runId: 5,
      runAttempt: 1,
    });
    expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(6);
    expect(
      await f.device.action(api.githubRuns.control, { key: "cancel-requested", command }),
    ).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([200, 201, 202, 204])(
  "rerun acceptance %s without a newer attempt is requested after five seconds",
  async (status) => {
    vi.useFakeTimers();
    const f = await fixture();
    f.setPost(async () => {
      f.run.status = "queued";
      return new Response(null, { status });
    });
    const pending = f.device.action(api.githubRuns.control, {
      key: "unchanged",
      command: f.command,
    });
    await vi.waitFor(() =>
      expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(2),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ state: "accepted", rerun: "requested", runAttempt: 1 });
    expect(
      await f.device.action(api.githubRuns.control, { key: "unchanged", command: f.command }),
    ).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("rerun acceptance observes a newer attempt after backoff", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.setPost(async () => new Response(null, { status: 201 }));
  const pending = f.device.action(api.githubRuns.control, {
    key: "delayed-rerun",
    command: f.command,
  });
  await vi.waitFor(() =>
    expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(2),
  );
  await vi.advanceTimersByTimeAsync(1000);
  f.run.run_attempt = 2;
  f.run.status = "queued";
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ state: "accepted", rerun: "observed", runAttempt: 2 });
  expect(f.posts()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a stalled post-acceptance read is aborted when the observation window ends", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.run.status = "in_progress";
  f.setPost(async () => new Response(null, { status: 202 }));
  const original = f.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  let readSignal: AbortSignal | undefined;
  f.fetch.mockImplementation((url, init) => {
    if (url.endsWith("/actions/runs/5") && f.posts().length) {
      readSignal = init?.signal ?? undefined;
      if (!readSignal) throw new Error("Missing observation signal");
      const signal = readSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return original(url, init);
  });
  const pending = f.device.action(api.githubRuns.control, {
    key: "stalled-read",
    command: { ...f.command, type: "run.cancel" },
  });
  await vi.waitFor(() => expect(readSignal).toBeDefined());
  await vi.advanceTimersByTimeAsync(20000);
  expect(await pending).toMatchObject({ state: "accepted", cancellation: "requested" });
  expect(readSignal?.aborted).toBe(true);
  expect(f.posts()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([200, 204])(
  "dispatch %s reports only returned run details and canonical inputs deduplicate",
  async (status) => {
    const f = await fixture();
    f.setPost(async () =>
      status === 204
        ? new Response(null, { status })
        : Response.json({
            workflow_run_id: 5,
            html_url: f.run.html_url,
            run_url: "https://api.github.com/repos/owner/sandbox/actions/runs/5",
          }),
    );
    const command = {
      type: "workflow.dispatch",
      bindingId: f.bindingId,
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: "staging", version: "a=b" },
    } as const;
    const outcome = await f.device.action(api.githubRuns.control, { key: "dispatch", command });
    expect(outcome).toMatchObject({ state: "accepted" });
    if (status === 200) expect(outcome).toMatchObject({ runId: 5, htmlUrl: f.run.html_url });
    else expect(outcome).not.toHaveProperty("runId");
    expect(JSON.parse(String(f.posts()[0]?.[1]?.body))).toEqual({
      ref: "main",
      inputs: command.inputs,
    });
    expect(
      await f.device.action(api.githubRuns.control, {
        key: "dispatch",
        command: { ...command, inputs: { version: "a=b", target: "staging" } },
      }),
    ).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
  },
);

test("permission denial is coded and an accepted POST stays requested despite unreadable state", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.setPost(async () =>
    Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
  );
  expect(
    await f.device.action(api.githubRuns.control, { key: "permission", command: f.command }),
  ).toMatchObject({
    state: "rejected",
    code: "github_app_permission_required",
    nextStep: expect.stringContaining("Approve the updated"),
  });
  f.setPost(async () => {
    f.run.repository.id = 99;
    return new Response(null, { status: 202 });
  });
  const pending = f.device.action(api.githubRuns.control, { key: "read-lost", command: f.command });
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toMatchObject({ state: "accepted", rerun: "requested" });
  expect(vi.getTimerCount()).toBe(0);
});

test("binding access is rechecked immediately before POST", async () => {
  const f = await fixture();
  const original = f.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  f.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (url.includes("/jobs?"))
      await f.t.run((ctx) => ctx.db.patch("repositoryBindings", f.bindingId, { enabled: false }));
    return response;
  });
  expect(
    await f.device.action(api.githubRuns.control, { key: "revoked", command: f.command }),
  ).toMatchObject({ state: "rejected", code: "repository_access_denied" });
  expect(f.posts()).toHaveLength(0);
});

test("remote replay after a lost local response and lost local database still POSTs only once", async () => {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), "vectis-run-replay-"));
  let store = new Store(join(home, "state.sqlite"));
  const broker = {
    controlRun: (command: RunControlCommand, key: string, _signal: AbortSignal) =>
      f.device.action(api.githubRuns.control, { command, key }),
    analyzeMigration: async () => {
      throw new Error("unused");
    },
    publishMigration: async () => {
      throw new Error("unused");
    },
    repositories: async () => [],
    connectRepository: async () => "unused",
    disconnectRepository: async () => {},
    setAutomatic: async () => {},
    scanJobs: async () => ({ runs: 0, jobs: 0, complete: true }),
    refreshJob: async () => {
      throw new Error("unused");
    },
    reconcileRunner: async () => {
      throw new Error("unused");
    },
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    jobLogs: async () => {
      throw new Error("unused");
    },
    setAccess: async () => {},
    prepareRunner: async () => ({ state: "released" as const, id: "unused" }),
    releaseRunner: async () => {},
  };
  let service = new Service(store, new VmRuntime({ home }), () => broker);
  const owner = f.t.withIdentity({
    issuer: "https://clerk.test",
    subject: "owner",
    tokenIdentifier: "owner",
  });
  const id = await owner.mutation(api.operations.submit, {
    machineId: f.machineId,
    key: "remote-rerun",
    commandJson: JSON.stringify(f.command),
  });
  const pending = async () => {
    const [operation] = await f.device.query(api.operations.pending, {});
    if (!operation) throw new Error("Missing remote operation");
    return operation;
  };
  const acknowledge = (args: Acknowledgement) =>
    f.device.mutation(api.operations.acknowledge, args);
  const local = {
    submit: async (command: Parameters<Service["submit"]>[1], key: string) =>
      service.submit(key, command),
    status: async () => service.snapshot(),
  };
  const signal = new AbortController().signal;
  try {
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    await expect(
      advanceRemoteOperation(
        await pending(),
        {
          ...local,
          submit: async (command, key) => {
            service.submit(key, command);
            throw new Error("Local response lost");
          },
        },
        acknowledge,
        signal,
      ),
    ).rejects.toThrow("Local response lost");
    await service.drain();
    await vi.waitFor(() =>
      expect(
        store.snapshot().operations.find((operation) => operation.key === `remote:${id}`)?.status,
      ).toBe("succeeded"),
    );
    await service.close();
    store.close();
    await rm(join(home, "state.sqlite"));
    store = new Store(join(home, "state.sqlite"));
    service = new Service(store, new VmRuntime({ home }), () => broker);
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    await service.drain();
    await vi.waitFor(() => expect(store.snapshot().operations[0]?.status).toBe("succeeded"));
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    await advanceRemoteOperation(await pending(), local, acknowledge, signal);
    expect((await owner.query(api.operations.get, { id })).phase).toBe("succeeded");
    expect(f.posts()).toHaveLength(1);
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a binding on another machine rejects this machine before API access", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      owner: "owner",
      localId: "other",
      name: "Other",
      createdAt: 1,
    });
    await ctx.db.patch("repositoryBindings", f.bindingId, { machineId });
  });
  await expect(
    f.device.action(api.githubRuns.control, { key: "other-machine", command: f.command }),
  ).rejects.toThrow("repository_access_denied");
  expect(f.fetch).not.toHaveBeenCalled();
});

test.each(["network", "malformed"])(
  "ambiguous dispatch %s never dispatches again on replay",
  async (failure) => {
    const f = await fixture();
    f.setPost(async () => {
      if (failure === "network") throw new TypeError("Dispatch response lost");
      return Response.json({ unexpected: "response" });
    });
    const command = {
      type: "workflow.dispatch",
      bindingId: f.bindingId,
      workflow: 12,
      ref: "main",
    } as const;
    const outcome = await f.device.action(api.githubRuns.control, {
      key: "dispatch-unknown",
      command,
    });
    expect(outcome).toMatchObject({ state: "uncertain", code: "run_command_unconfirmed" });
    expect(
      await f.device.action(api.githubRuns.control, { key: "dispatch-unknown", command }),
    ).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
  },
);

test("token minting permission refusal crosses repositoryAccess with the same recovery code", async () => {
  const f = await fixture();
  const original = f.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  f.fetch.mockImplementation(async (url, init) =>
    url.endsWith("/access_tokens")
      ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
      : original(url, init),
  );
  expect(
    await f.device.action(api.githubRuns.control, { key: "mint-denied", command: f.command }),
  ).toMatchObject({
    state: "rejected",
    code: "github_app_permission_required",
    nextStep: expect.stringContaining("Settings -> Applications"),
  });
  expect(f.posts()).toHaveLength(0);
});

test("a revoked machine cannot replay receipts or make a POST", async () => {
  const f = await fixture();
  await f.device.action(api.githubRuns.control, { key: "revoked-machine", command: f.command });
  await f.t.run((ctx) => ctx.db.delete("machines", f.machineId));
  await expect(
    f.device.action(api.githubRuns.control, { key: "revoked-machine", command: f.command }),
  ).rejects.toThrow("machine_revoked");
  expect(f.posts()).toHaveLength(1);
});

test("revocation after POST leaves an unconfirmed receipt instead of claiming a persisted success", async () => {
  const f = await fixture();
  f.setBeforePost(async () => {
    await f.t.run((ctx) => ctx.db.delete("machines", f.machineId));
  });
  expect(
    await f.device.action(api.githubRuns.control, { key: "finish-revoked", command: f.command }),
  ).toMatchObject({ state: "uncertain", code: "run_command_unconfirmed" });
  expect(await f.t.run((ctx) => ctx.db.query("runCommandReceipts").unique())).toMatchObject({
    state: "submitted",
  });
  expect(f.posts()).toHaveLength(1);
});

test("202 cancellation acceptance does not depend on parsing the response body", async () => {
  const f = await fixture();
  f.run.status = "in_progress";
  f.setPost(async () => {
    f.run.status = "completed";
    f.run.conclusion = "cancelled";
    return new Response("Accepted", { status: 202 });
  });
  expect(
    await f.device.action(api.githubRuns.control, {
      key: "accepted-body",
      command: { ...f.command, type: "run.cancel" },
    }),
  ).toMatchObject({ state: "accepted", cancellation: "observed" });
  expect(f.posts()).toHaveLength(1);
});
