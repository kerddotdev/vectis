import worker from "../src/index.js";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ScaleSetGrant } from "../../../packages/protocol/src/scale-sets.js";
import { runnerLabels } from "../../../packages/github/src/runner-labels.js";
import {
  env,
  seedMachine,
  seedApp,
  seedAccount,
  seedBinding,
  readyLinux,
} from "../src/test-support.js";
import { markScaleSetsForCleanup, sweepScaleSets } from "../src/runners/scale-sets.js";
import type { ScaleSetRow } from "../src/db.js";
const serviceUrl = "https://actions.example.test/tenant/repository/";
const jwt = (exp: number) => `header.${btoa(JSON.stringify({ exp }))}.signature`;
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const machine = await seedMachine({ environments: [readyLinux()] });
  const account = await seedAccount(machine.owner);
  const binding = await seedBinding({
    owner: machine.owner,
    accountId: account.id,
    machineId: machine.id,
    capacityMode: "scale_set",
    automatic: true,
  });
  await seedApp();
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
    installationId: 10,
    repositoryId: 1000,
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
  const fetchMock = stubFetch(async (request) => {
    const input = request.url;
    const init = {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      body: request.method === "POST" ? await request.text() : undefined,
    };
    const url = new URL(input);
    const path = url.pathname;
    if (url.hostname === "api.github.com") {
      if (path.endsWith("/installation"))
        return Response.json({
          id: state.installationId,
          app_id: 1,
          account: { id: 100, type: "User" },
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
      if (path === "/repos/octo/repo")
        return Response.json({ id: state.repositoryId, private: true, owner: { id: 100 } });
    }
    if (url.hostname !== "actions.example.test")
      throw new Error(`Unexpected synthetic request ${url.href}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${adminToken}`);
    expect(init?.redirect).toBe("manual");
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

  const open = async () => {
    const response = await machineRequest("/machine/scale-sets/open", machine.bearer, {
      bindingId: binding.id,
    });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(ScaleSetGrant)(await response.json());
  };
  const rows = async () =>
    (
      await env.DB.prepare("SELECT * FROM runnerScaleSets WHERE bindingId = ?")
        .bind(binding.id)
        .all<ScaleSetRow>()
    ).results;
  return { machine, binding, state, open, rows, fetchMock };
}
it("opens, refreshes and closes a listener while fencing old generations", async () => {
  const f = await fixture();
  const first = await f.open();
  expect(first).toMatchObject({ scaleSetId: 17, generation: 1 });
  const args = { bindingId: f.binding.id, generation: first.generation };
  expect(
    await (await machineRequest("/machine/scale-sets/refresh", f.machine.bearer, args)).json(),
  ).toMatchObject({ sessionId: first.sessionId });
  for (let i = 0; i < 2; i++)
    expect((await machineRequest("/machine/scale-sets/close", f.machine.bearer, args)).status).toBe(
      200,
    );
  expect(await f.rows()).toMatchObject([{ phase: "closed", sessionId: null }]);
  const next = await f.open();
  expect(next.generation).toBe(2);
  expect(
    await (await machineRequest("/machine/scale-sets/close", f.machine.bearer, args)).json(),
  ).toMatchObject({ code: "scale_set_superseded" });
});
it("cleans up remote sets after their binding and machine are deleted", async () => {
  const f = await fixture();
  await f.open();
  await markScaleSetsForCleanup(env, [f.binding.id]);
  await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(f.machine.id).run();
  expect(await f.rows()).toMatchObject([{ phase: "deleting", cleanupAttempt: 0 }]);
  await sweepScaleSets(env, Date.now());
  expect(await f.rows()).toEqual([]);
});
it("bounds cleanup retries and leaves terminal failures for explicit retry", async () => {
  const f = await fixture();
  await f.open();
  f.state.failDelete = 8;
  await markScaleSetsForCleanup(env, [f.binding.id]);
  let now = Date.now();
  for (let i = 0; i < 8; i++) {
    await sweepScaleSets(env, now);
    now += 900001;
  }
  expect(await f.rows()).toMatchObject([
    { phase: "action_required", cleanupDueAt: null, cleanupAttempt: 8 },
  ]);
  await markScaleSetsForCleanup(env, [f.binding.id]);
  await sweepScaleSets(env, now);
  expect(await f.rows()).toEqual([]);
});
it("records a session conflict without leaking queue or admin credentials", async () => {
  const f = await fixture();
  f.state.conflict = true;
  const response = await machineRequest("/machine/scale-sets/open", f.machine.bearer, {
    bindingId: f.binding.id,
  });
  expect(await response.json()).toMatchObject({ code: "scale_set_session_conflict" });
  expect(await f.rows()).toMatchObject([{ phase: "action_required", sessionId: null }]);
});
it("withholds a session created after cleanup fences its generation", async () => {
  const f = await fixture();
  f.state.onSession = () => markScaleSetsForCleanup(env, [f.binding.id]);
  const response = await machineRequest("/machine/scale-sets/open", f.machine.bearer, {
    bindingId: f.binding.id,
  });
  expect(await response.json()).toMatchObject({ code: "scale_set_superseded" });
  expect(await f.rows()).toMatchObject([{ phase: "deleting", generation: 2 }]);
});
it("refuses unsupported actor policies before contacting GitHub", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE repositoryBindings SET accessJson = ? WHERE id = ?")
    .bind(JSON.stringify({ actors: "any", approval: "required" }), f.binding.id)
    .run();
  expect(
    await (
      await machineRequest("/machine/scale-sets/open", f.machine.bearer, {
        bindingId: f.binding.id,
      })
    ).json(),
  ).toMatchObject({ code: "scale_set_policy_unsupported" });
  expect(f.fetchMock).not.toHaveBeenCalled();
});

async function machineRequest(path: string, bearer: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://cloud.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
beforeEach(async () => {
  await env.DB.batch(
    ["machines", "githubAccounts", "githubApps", "githubJobs", "runnerScaleSets"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

function stubFetch(handler: (request: Request) => Promise<Response> | Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(new Request(input, init)));
}

it("registers scale set JIT runners only when repository identity agrees", async () => {
  const f = await fixture();
  await f.open();
  f.state.wrongRepositoryRunner = true;
  const response = await machineRequest("/machine/runners/prepare", f.machine.bearer, {
    bindingId: f.binding.id,
    key: "scale-runner",
    scaleSet: { generation: 1 },
  });
  expect(await response.json()).toMatchObject({ state: "action_required" });
  expect(
    await env.DB.prepare("SELECT encodedConfig FROM runnerLeases").first("encodedConfig"),
  ).toBeNull();
});
it("rejects labels changed at GitHub before creating JIT credentials", async () => {
  const f = await fixture();
  await f.open();
  f.state.dropLabels = true;
  const response = await machineRequest("/machine/runners/prepare", f.machine.bearer, {
    bindingId: f.binding.id,
    key: "changed-labels",
    scaleSet: { generation: 1 },
  });
  expect(await response.json()).toMatchObject({ state: "action_required" });
  expect(
    f.fetchMock.mock.calls.some(([r]) =>
      String(r instanceof Request ? r.url : r).includes("/generatejitconfig"),
    ),
  ).toBe(false);
});
it("lets disabled automatic capacity close its session while refusing refresh", async () => {
  const f = await fixture();
  const grant = await f.open();
  await env.DB.prepare("UPDATE repositoryBindings SET automatic = 0 WHERE id = ?")
    .bind(f.binding.id)
    .run();
  const args = { bindingId: f.binding.id, generation: grant.generation };
  expect(
    await (await machineRequest("/machine/scale-sets/refresh", f.machine.bearer, args)).json(),
  ).toMatchObject({ code: "automatic_disabled" });
  expect((await machineRequest("/machine/scale-sets/close", f.machine.bearer, args)).status).toBe(
    200,
  );
  expect(await f.rows()).toMatchObject([{ phase: "closed" }]);
});

it("permits only one concurrent listener open", async () => {
  const f = await fixture();
  const responses = await Promise.all(
    [1, 2].map(() =>
      machineRequest("/machine/scale-sets/open", f.machine.bearer, { bindingId: f.binding.id }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await f.rows()).toMatchObject([{ generation: 1, phase: "active" }]);
});
