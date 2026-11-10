import worker from "../src/index.js";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { RunnerGrant } from "../../../packages/protocol/src/runners.js";
import {
  env,
  seedMachine,
  seedAccount,
  seedBinding,
  seedApp,
  readyLinux,
} from "../src/test-support.js";
import { sweepLeases } from "../src/runners/leases.js";
import type { LeaseRow } from "../src/db.js";
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const machine = await seedMachine({ environments: [readyLinux()] });
  const account = await seedAccount(machine.owner);
  const binding = await seedBinding({
    owner: machine.owner,
    accountId: account.id,
    machineId: machine.id,
  });
  await seedApp();
  let name = "";
  const state = {
    lost: false,
    busy: false,
    wrong: false,
    onRegistration: undefined as (() => Promise<void>) | undefined,
  };
  const fetch = stubFetch(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/installation"))
      return Response.json({
        id: 10,
        app_id: 1,
        account: { id: 100, type: "User" },
        suspended_at: null,
      });
    if (path.endsWith("/access_tokens")) return Response.json({ token: "test-installation-token" });
    if (path === "/repos/octo/repo")
      return Response.json({ id: 1000, private: true, owner: { id: 100 } });
    if (path.endsWith("/fork-pr-workflows-private-repos"))
      return Response.json({
        run_workflows_from_fork_pull_requests: false,
        require_approval_for_fork_pr_workflows: false,
      });
    if (path.endsWith("/generate-jitconfig")) {
      const body = (await request.json()) as { name: string };
      name = body.name;
      await state.onRegistration?.();
      if (state.lost) throw new Error("Lost response");
      return Response.json({ runner: { id: 501, name }, encoded_jit_config: "c2VjcmV0" });
    }
    if (path.endsWith("/actions/runners/501"))
      return request.method === "DELETE"
        ? state.busy
          ? new Response(null, { status: 422 })
          : new Response(null, { status: 204 })
        : Response.json({
            id: 501,
            name: state.wrong ? "foreign" : name,
            busy: false,
            status: "online",
          });
    if (path.endsWith("/actions/runners"))
      return Response.json({ total_count: 1, runners: [{ id: 501, name }] });
    throw new Error(`Unexpected test request ${request.url}`);
  });
  const prepare = async (key = "request") => {
    const response = await machineRequest("/machine/runners/prepare", machine.bearer, {
      bindingId: binding.id,
      key,
    });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(RunnerGrant)(await response.json());
  };
  return { machine, binding, state, fetch, prepare };
}
it("deduplicates grants and release, and status polls do not write leases", async () => {
  const f = await fixture();
  const first = await f.prepare();
  expect(first.state).toBe("ready");
  expect(await f.prepare()).toEqual(first);
  const before = await env.DB.prepare("SELECT * FROM runnerLeases WHERE id = ?")
    .bind(first.id)
    .first();
  for (let i = 0; i < 2; i++) {
    const status = await machineRequest("/machine/runners/status", f.machine.bearer, {
      id: first.id,
    });
    expect(await status.json()).toEqual({ busy: false, status: "online" });
  }
  expect(
    await env.DB.prepare("SELECT * FROM runnerLeases WHERE id = ?").bind(first.id).first(),
  ).toEqual(before);
  for (let i = 0; i < 2; i++)
    expect(
      await (
        await machineRequest("/machine/runners/release", f.machine.bearer, { id: first.id })
      ).json(),
    ).toEqual({ state: "released", id: first.id });
  expect(await f.prepare()).toEqual({ state: "released", id: first.id });
  expect(
    f.fetch.mock.calls.filter(([r]) =>
      String(r instanceof Request ? r.url : r).endsWith("/generate-jitconfig"),
    ),
  ).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
});
it("fences missing requests and rejects foreign machines", async () => {
  const f = await fixture();
  const request = { bindingId: f.binding.id, environmentId: "linux", key: "fenced" };
  const foreign = await seedMachine({ environments: [readyLinux()] });
  expect((await machineRequest("/machine/runners/reconcile", foreign.bearer, request)).status).toBe(
    403,
  );
  const a = await machineRequest("/machine/runners/reconcile", f.machine.bearer, request);
  const lease = await a.json();
  expect(lease).toMatchObject({ phase: "released" });
  expect(
    await (await machineRequest("/machine/runners/reconcile", f.machine.bearer, request)).json(),
  ).toEqual(lease);
  expect(await f.prepare("fenced")).toMatchObject({ state: "released" });
  expect(
    f.fetch.mock.calls.some(([r]) =>
      String(r instanceof Request ? r.url : r).endsWith("/generate-jitconfig"),
    ),
  ).toBe(false);
});
it("does not retry registration after a lost response and discovers it for cleanup", async () => {
  const f = await fixture();
  f.state.lost = true;
  const lease = await f.prepare();
  expect(lease.state).toBe("action_required");
  expect(await f.prepare()).toEqual(lease);
  expect(
    (await machineRequest("/machine/runners/release", f.machine.bearer, { id: lease.id })).status,
  ).toBe(200);
});
it("withholds credentials when the binding is disabled during registration", async () => {
  const f = await fixture();
  f.state.onRegistration = async () => {
    await env.DB.prepare("UPDATE repositoryBindings SET enabled = 0 WHERE id = ?")
      .bind(f.binding.id)
      .run();
  };
  const grant = await f.prepare();
  expect(grant.state).toBe("action_required");
  const row = await env.DB.prepare("SELECT * FROM runnerLeases WHERE id = ?")
    .bind(grant.id)
    .first<LeaseRow>();
  expect(row?.encodedConfig).toBeNull();
  expect(row?.runnerId).toBe(501);
  expect(
    (await machineRequest("/machine/runners/release", f.machine.bearer, { id: grant.id })).status,
  ).toBe(200);
});
it("expires JIT credentials without changing live lease identity", async () => {
  const f = await fixture();
  const grant = await f.prepare();
  await env.DB.prepare("UPDATE runnerLeases SET configExpiresAt = ? WHERE id = ?")
    .bind(Date.now() - 1, grant.id)
    .run();
  await sweepLeases(env, Date.now());
  const row = await env.DB.prepare("SELECT * FROM runnerLeases WHERE id = ?")
    .bind(grant.id)
    .first<LeaseRow>();
  expect(row).toMatchObject({
    phase: "ready",
    runnerId: 501,
    encodedConfig: null,
    configExpiresAt: null,
  });
  expect(await f.prepare()).toMatchObject({ state: "action_required" });
});
it("rejects cleanup of a mismatched runner and preserves busy runners", async () => {
  const f = await fixture();
  const grant = await f.prepare();
  f.state.wrong = true;
  expect(
    await (
      await machineRequest("/machine/runners/release", f.machine.bearer, { id: grant.id })
    ).json(),
  ).toMatchObject({ code: "runner_identity_conflict" });
  f.state.wrong = false;
  f.state.busy = true;
  expect(
    await (
      await machineRequest("/machine/runners/release", f.machine.bearer, { id: grant.id })
    ).json(),
  ).toMatchObject({ code: "runner_busy" });
  expect(
    await env.DB.prepare("SELECT phase FROM runnerLeases WHERE id = ?").bind(grant.id).first(),
  ).toEqual({ phase: "ready" });
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

it("serializes concurrent prepares with one durable registration", async () => {
  const f = await fixture();
  const grants = await Promise.all([f.prepare(), f.prepare()]);
  expect(grants[0]?.id).toBe(grants[1]?.id);
  expect(grants.some((grant) => grant.state === "ready")).toBe(true);
  expect(
    f.fetch.mock.calls.filter(([r]) =>
      String(r instanceof Request ? r.url : r).endsWith("/generate-jitconfig"),
    ),
  ).toHaveLength(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runnerLeases").first("n")).toBe(1);
});
it("withholds credentials if the environment revision changes during registration", async () => {
  const f = await fixture();
  f.state.onRegistration = async () => {
    await env.DB.prepare("UPDATE machines SET environmentsJson = ? WHERE id = ?")
      .bind(JSON.stringify([{ ...readyLinux(), revision: "new-image" }]), f.machine.id)
      .run();
  };
  expect(await f.prepare()).toMatchObject({ state: "action_required" });
  expect(
    await env.DB.prepare("SELECT encodedConfig FROM runnerLeases").first("encodedConfig"),
  ).toBeNull();
});
it("requires a matching queued job and explicit approval for restricted runners", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE repositoryBindings SET accessJson = ?, automatic = 1 WHERE id = ?")
    .bind(JSON.stringify({ actors: { ids: [7] }, approval: "required" }), f.binding.id)
    .run();
  const prepare = (extra: Record<string, unknown>) =>
    machineRequest("/machine/runners/prepare", f.machine.bearer, {
      bindingId: f.binding.id,
      key: "restricted",
      ...extra,
    });
  expect(await (await prepare({})).json()).toMatchObject({ code: "job_required" });
  expect(await (await prepare({ jobId: 1 })).json()).toMatchObject({ code: "job_not_queued" });
  await env.DB.prepare(
    `INSERT INTO githubJobs (installationId,repositoryId,jobId,runId,runAttempt,actorId,triggeringActorId,name,status,labelsJson,updatedAt) VALUES (10,1000,1,2,1,7,7,'Build','queued','["vectis-linux"]',1)`,
  ).run();
  expect(await (await prepare({ jobId: 1, automatic: true })).json()).toMatchObject({
    code: "approval_required",
  });
  expect(await (await prepare({ jobId: 1 })).json()).toMatchObject({
    state: "ready",
    access: { approvedRun: { runId: 2, runAttempt: 1 } },
  });
  expect(await (await prepare({ jobId: 1, automatic: true })).json()).toMatchObject({
    code: "approval_required",
  });
});
it("rejects foreign status requests before GitHub access", async () => {
  const f = await fixture();
  const grant = await f.prepare();
  const foreign = await seedMachine();
  f.fetch.mockClear();
  expect(
    await (
      await machineRequest("/machine/runners/status", foreign.bearer, { id: grant.id })
    ).json(),
  ).toMatchObject({ code: "runner_lease_missing" });
  expect(f.fetch).not.toHaveBeenCalled();
});
