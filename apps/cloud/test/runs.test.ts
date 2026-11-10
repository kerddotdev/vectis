import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Schema } from "effect";
import worker from "../src/index.js";
import { env, seedMachine, seedAccount, seedBinding, seedApp } from "../src/test-support.js";
import { RunControlOutcome, type RunControlCommand } from "../../../packages/protocol/src/runs.js";

beforeEach(async () => {
  await env.DB.batch(
    ["machines", "githubAccounts", "githubApps", "githubJobs"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  const machine = await seedMachine();
  const account = await seedAccount(machine.owner, { githubId: 7, login: "owner" });
  const binding = await seedBinding({
    owner: machine.owner,
    accountId: account.id,
    machineId: machine.id,
    repositoryId: 2,
    repositoryName: "sandbox",
    installationId: 3,
  });
  await seedApp();
  const run = {
    id: 5,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/owner/sandbox/actions/runs/5",
    repository: { id: 2 },
  };
  let failedJobs = true;
  let beforePost: (() => Promise<unknown>) | undefined;
  let post: () => Promise<Response> = async () => {
    run.run_attempt++;
    run.status = "queued";
    return new Response(null, { status: 201 });
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 3,
        app_id: 1,
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
      expect(
        await env.DB.prepare("SELECT * FROM runCommandReceipts WHERE state = 'submitted'").first(),
      ).not.toBeNull();
      await beforePost?.();
      return post();
    }
    if (url.includes("/jobs?"))
      return Response.json({
        total_count: 1,
        jobs: [{ id: 1, conclusion: failedJobs ? "failure" : "success" }],
      });
    if (url.endsWith("/actions/runs/5")) return Response.json(run);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => fetch(String(input), init));
  const control = async (args: { key: string; command: RunControlCommand }) => {
    const response = await worker.fetch(
      new Request("https://cloud.test/machine/runs/control", {
        method: "POST",
        headers: { Authorization: `Bearer ${machine.bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      }),
      env,
      createExecutionContext(),
    );
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return Schema.decodeUnknownSync(RunControlOutcome)(body);
  };
  const patch = async (values: Record<string, string | number>) => {
    await env.DB.prepare(
      `UPDATE repositoryBindings SET ${Object.keys(values)
        .map((k) => k + " = ?")
        .join(", ")} WHERE id = ?`,
    )
      .bind(...Object.values(values), binding.id)
      .run();
  };
  return {
    machine,
    machineId: machine.id,
    bindingId: binding.id,
    command: { type: "run.rerun-failed", bindingId: binding.id, runId: 5 } as const,
    run,
    fetch,
    control,
    patch,
    posts: () =>
      fetch.mock.calls.filter(
        ([url, init]) => init?.method === "POST" && !url.endsWith("/access_tokens"),
      ),
    setPost: (callback: () => Promise<Response>) => {
      post = callback;
    },
    setBeforePost: (callback: () => Promise<unknown>) => {
      beforePost = callback;
    },
    setFailedJobs: (value: boolean) => {
      failedJobs = value;
    },
  };
}
test("a newer attempt confirms rerun and a stored receipt prevents a second POST", async () => {
  const f = await fixture();
  const outcome = await f.control({
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
  expect(await f.control({ key: "rerun", command: f.command })).toEqual(outcome);
  expect(f.posts()).toHaveLength(1);
  expect(
    JSON.stringify(
      await env.DB.prepare("SELECT * FROM runCommandReceipts")
        .all()
        .then((r) => r.results),
    ),
  ).not.toContain("test-actions-token");
  await expect(f.control({ key: "rerun", command: { ...f.command, runId: 6 } })).rejects.toThrow(
    "idempotency_conflict",
  );
});

test("another owner's binding is rejected before any GitHub request", async () => {
  const f = await fixture();
  await f.patch({ owner: "other" });
  await expect(f.control({ key: "foreign", command: f.command })).rejects.toThrow(
    "repository_access_denied",
  );
  expect(f.fetch).not.toHaveBeenCalled();
});

test("a run from another repository is refused without POST", async () => {
  const f = await fixture();
  f.run.repository.id = 99;
  expect(await f.control({ key: "wrong-repo", command: f.command })).toMatchObject({
    state: "rejected",
    code: "run_repository_mismatch",
  });
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
    const outcome = await f.control({
      key: "uncertain",
      command,
    });
    expect(outcome).toMatchObject({
      state: "uncertain",
      code: "run_command_unconfirmed",
      nextStep: expect.stringContaining("Check the run on GitHub"),
    });
    expect(await f.control({ key: "uncertain", command })).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT * FROM runCommandReceipts").first()).toMatchObject({
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
  const first = f.control({ key: "concurrent", command: f.command });
  await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(await f.control({ key: "concurrent", command: f.command })).toMatchObject({
    state: "uncertain",
    code: "run_command_unconfirmed",
  });
  release();
  expect(await first).toMatchObject({ state: "accepted" });
  const receipt = await env.DB.prepare("SELECT * FROM runCommandReceipts").first();
  if (!receipt) throw new Error("Missing receipt");
  await env.DB.prepare(
    "UPDATE runCommandReceipts SET state = 'submitted', outcomeJson = NULL",
  ).run();
  expect(await f.control({ key: "concurrent", command: f.command })).toMatchObject({
    state: "uncertain",
  });
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
    expect(await f.control({ key: "refused", command })).toMatchObject({
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
    const pending = f.control({ key: "cancel", command });
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
    expect(await f.control({ key: "cancel", command })).toEqual(outcome);
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
    const pending = f.control({ key: "cancel-requested", command });
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
    expect(await f.control({ key: "cancel-requested", command })).toEqual(outcome);
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
    const pending = f.control({
      key: "unchanged",
      command: f.command,
    });
    await vi.waitFor(() =>
      expect(f.fetch.mock.calls.filter(([url]) => url.endsWith("/actions/runs/5"))).toHaveLength(2),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ state: "accepted", rerun: "requested", runAttempt: 1 });
    expect(await f.control({ key: "unchanged", command: f.command })).toEqual(outcome);
    expect(f.posts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("rerun acceptance observes a newer attempt after backoff", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.setPost(async () => new Response(null, { status: 201 }));
  const pending = f.control({
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
  const pending = f.control({
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
    const outcome = await f.control({ key: "dispatch", command });
    expect(outcome).toMatchObject({ state: "accepted" });
    if (status === 200) expect(outcome).toMatchObject({ runId: 5, htmlUrl: f.run.html_url });
    else expect(outcome).not.toHaveProperty("runId");
    expect(JSON.parse(String(f.posts()[0]?.[1]?.body))).toEqual({
      ref: "main",
      inputs: command.inputs,
    });
    expect(
      await f.control({
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
  expect(await f.control({ key: "permission", command: f.command })).toMatchObject({
    state: "rejected",
    code: "github_app_permission_required",
    nextStep: expect.stringContaining("Approve the updated"),
  });
  f.setPost(async () => {
    f.run.repository.id = 99;
    return new Response(null, { status: 202 });
  });
  const pending = f.control({ key: "read-lost", command: f.command });
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
    if (url.includes("/jobs?")) await f.patch({ enabled: 0 });
    return response;
  });
  expect(await f.control({ key: "revoked", command: f.command })).toMatchObject({
    state: "rejected",
    code: "repository_access_denied",
  });
  expect(f.posts()).toHaveLength(0);
});

test("a binding on another machine rejects this machine before API access", async () => {
  const f = await fixture();
  const other = await seedMachine({ owner: f.machine.owner });
  await f.patch({ machineId: other.id });
  await expect(f.control({ key: "other-machine", command: f.command })).rejects.toThrow(
    "repository_access_denied",
  );
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
    const outcome = await f.control({
      key: "dispatch-unknown",
      command,
    });
    expect(outcome).toMatchObject({ state: "uncertain", code: "run_command_unconfirmed" });
    expect(await f.control({ key: "dispatch-unknown", command })).toEqual(outcome);
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
  expect(await f.control({ key: "mint-denied", command: f.command })).toMatchObject({
    state: "rejected",
    code: "github_app_permission_required",
    nextStep: expect.stringContaining("Settings -> Applications"),
  });
  expect(f.posts()).toHaveLength(0);
});

test("a revoked machine cannot replay receipts or make a POST", async () => {
  const f = await fixture();
  await f.control({ key: "revoked-machine", command: f.command });
  await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(f.machineId).run();
  await expect(f.control({ key: "revoked-machine", command: f.command })).rejects.toThrow(
    "machine_revoked",
  );
  expect(f.posts()).toHaveLength(1);
});

test("revocation after POST leaves an unconfirmed receipt instead of claiming a persisted success", async () => {
  const f = await fixture();
  f.setBeforePost(async () => {
    await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(f.machineId).run();
  });
  expect(await f.control({ key: "finish-revoked", command: f.command })).toMatchObject({
    state: "uncertain",
    code: "run_command_unconfirmed",
  });
  expect(await env.DB.prepare("SELECT * FROM runCommandReceipts").first()).toBeNull();
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
    await f.control({
      key: "accepted-body",
      command: { ...f.command, type: "run.cancel" },
    }),
  ).toMatchObject({ state: "accepted", cancellation: "observed" });
  expect(f.posts()).toHaveLength(1);
});

test("attempt-scoped retries wait without reserving a POST, reject stale attempts and retain receipts", async () => {
  const f = await fixture();
  await f.patch({ infraRerun: 1 });
  const command = { ...f.command, expectedRunAttempt: 1, infraJobIds: [1] };
  f.run.status = "in_progress";
  expect(await f.control({ key: "infra-wait", command })).toMatchObject({
    state: "rejected",
    code: "run_not_ready",
  });
  expect(f.posts()).toHaveLength(0);
  expect(
    await env.DB.prepare("SELECT * FROM runCommandReceipts")
      .all()
      .then((r) => r.results),
  ).toHaveLength(0);
  f.run.status = "completed";
  expect(await f.control({ key: "infra-wait", command })).toMatchObject({
    state: "accepted",
    rerun: "observed",
    runAttempt: 2,
  });
  expect(await f.control({ key: "infra-wait", command })).toMatchObject({
    state: "accepted",
    rerun: "observed",
    runAttempt: 2,
  });
  f.run.status = "completed";
  expect(await f.control({ key: "infra-stale", command })).toMatchObject({
    state: "rejected",
    code: "run_attempt_changed",
  });
  expect(f.posts()).toHaveLength(1);
});

test("disabling infrastructure retry prevents a pending attempt-scoped POST", async () => {
  const f = await fixture();
  expect(
    await f.control({
      key: "infra-disabled",
      command: { ...f.command, expectedRunAttempt: 1 },
    }),
  ).toMatchObject({ state: "rejected", code: "repository_access_denied" });
  expect(f.posts()).toHaveLength(0);
});

test("automatic retries refuse a run with unrelated workflow failures", async () => {
  const f = await fixture();
  await f.patch({ infraRerun: 1 });
  const original = f.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  f.fetch.mockImplementation(async (url, init) =>
    url.includes("/jobs?")
      ? Response.json({
          total_count: 2,
          jobs: [
            { id: 1, conclusion: "failure" },
            { id: 2, conclusion: "failure" },
          ],
        })
      : original(url, init),
  );
  expect(
    await f.control({
      key: "infra-mixed",
      command: { ...f.command, expectedRunAttempt: 1, infraJobIds: [1] },
    }),
  ).toMatchObject({ state: "rejected", code: "run_has_workflow_failures" });
  expect(f.posts()).toHaveLength(0);
});

test.each([false, true])(
  "simultaneous requests reserve only one POST (attempt-scoped: %s)",
  async (attemptScoped) => {
    const f = await fixture();
    if (attemptScoped) await f.patch({ infraRerun: 1 });
    const command = {
      ...f.command,
      ...(attemptScoped ? { expectedRunAttempt: 1, infraJobIds: [1] } : {}),
    };
    const outcomes = await Promise.all([
      f.control({ key: "race", command }),
      f.control({ key: "race", command }),
    ]);
    expect(f.posts()).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.state === "accepted")).toBe(true);
  },
);
