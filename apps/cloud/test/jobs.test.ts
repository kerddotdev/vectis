import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  env,
  seedMachine,
  seedAccount,
  seedBinding,
  seedApp,
  machineRequest,
  stubFetch,
} from "../src/test-support.js";
import { storeJob } from "../src/github/job-store.js";
import { jobMarkers, leaseObservations } from "../src/github/jobs.js";
import { bindingRecord, machineRecord, type BindingRow, type MachineRow } from "../src/db.js";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM machines"),
    env.DB.prepare("DELETE FROM githubAccounts"),
    env.DB.prepare("DELETE FROM githubApps"),
    env.DB.prepare("DELETE FROM githubJobs"),
  ]);
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const machine = await seedMachine();
  const account = await seedAccount(machine.owner);
  const binding = await seedBinding({
    owner: machine.owner,
    machineId: machine.id,
    accountId: account.id,
  });
  return { machine, account, binding };
}
const job = {
  id: 4,
  run_id: 5,
  name: "build",
  status: "in_progress" as const,
  conclusion: null,
  labels: ["vectis-linux"],
  runner_id: 6,
  runner_name: "vectis-lease",
};

it("lists authorized jobs and rejects another machine or a disabled binding", async () => {
  const { machine, binding } = await fixture();
  await storeJob(env, job, 10, 1000);
  const response = await machineRequest("/machine/jobs/list", machine.bearer, {
    bindingId: binding.id,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([{ jobId: 4, status: "in_progress" }]);
  const foreign = await seedMachine({ owner: "other" });
  expect(
    (await machineRequest("/machine/jobs/list", foreign.bearer, { bindingId: binding.id })).status,
  ).toBe(403);
  await env.DB.prepare("UPDATE repositoryBindings SET enabled = 0 WHERE id = ?")
    .bind(binding.id)
    .run();
  expect(
    (await machineRequest("/machine/jobs/list", machine.bearer, { bindingId: binding.id })).status,
  ).toBe(403);
});
it("returns null markers without jobs and uses newest job update for each repository", async () => {
  const { binding } = await fixture();
  const row = await env.DB.prepare("SELECT * FROM repositoryBindings WHERE id = ?")
    .bind(binding.id)
    .first<BindingRow>();
  if (!row) throw new Error("Missing binding");
  const bindings = [bindingRecord(row)];
  expect(await jobMarkers(env, bindings)).toEqual({ [binding.id]: null });
  const result = await storeJob(env, job, 10, 1000);
  expect(await jobMarkers(env, bindings)).toEqual({ [binding.id]: result.row.updatedAt });
});
it("only reports unique matching jobs for the machine's leases", async () => {
  const { machine, binding } = await fixture();
  const row = await env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(machine.id)
    .first<MachineRow>();
  if (!row) throw new Error("Missing machine");
  const target = machineRecord(row);
  await env.DB.prepare(`INSERT INTO runnerLeases (id,owner,machineId,bindingId,environmentId,os,key,phase,createdAt,updatedAt,automatic,runnerId)
    VALUES ('lease',?,?,?,'linux','linux','key','ready',1,1,0,6)`)
    .bind(machine.owner, machine.id, binding.id)
    .run();
  await storeJob(env, job, 10, 1000);
  expect(await leaseObservations(env, target, ["lease", "lease"])).toMatchObject([
    { leaseId: "lease", job: { jobId: 4 } },
  ]);
  const other = await seedMachine({ owner: "other" });
  const otherRow = await env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(other.id)
    .first<MachineRow>();
  if (!otherRow) throw new Error("Missing machine");
  expect(await leaseObservations(env, machineRecord(otherRow), ["lease"])).toEqual([]);
  await storeJob(env, { ...job, id: 7, runner_id: 99 }, 10, 1000);
  expect(await leaseObservations(env, target, ["lease"])).toEqual([]);
  await expect(
    leaseObservations(
      env,
      target,
      Array.from({ length: 21 }, () => "lease"),
    ),
  ).rejects.toMatchObject({ code: "invalid_lease_ids" });
});
it("refreshes missing jobs through repository authority and reports an unknown job", async () => {
  const { machine, binding } = await fixture();
  await seedApp();
  stubFetch((request) => {
    const url = request.url;
    if (url.endsWith("/installation"))
      return Response.json({
        id: 10,
        app_id: 1,
        account: { id: 100, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "test-read-only" });
    if (url.endsWith("/actions/jobs/4")) return Response.json(job);
    if (url.endsWith("/actions/jobs/9")) return new Response(null, { status: 404 });
    if (url.endsWith("/repos/octo/repo"))
      return Response.json({ id: 1000, private: true, owner: { id: 100 } });
    return undefined;
  });
  const response = await machineRequest("/machine/jobs/refresh", machine.bearer, {
    bindingId: binding.id,
    jobId: 4,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ jobId: 4, status: "in_progress" });
  const missing = await machineRequest("/machine/jobs/refresh", machine.bearer, {
    bindingId: binding.id,
    jobId: 9,
  });
  expect(await missing.json()).toMatchObject({ code: "job_not_found" });
});

it("scans pending runs once and enriches jobs required by restrictive bindings", async () => {
  const { machine, binding } = await fixture();
  await seedApp();
  await env.DB.prepare("UPDATE repositoryBindings SET accessJson = ? WHERE id = ?")
    .bind(JSON.stringify({ actors: "any", approval: "required" }), binding.id)
    .run();
  await storeJob(env, { ...job, id: 8, run_id: 9 }, 10, 1000);
  const { GitHubAppClient } = await import("../../../packages/github/src/app-client.js");
  vi.spyOn(GitHubAppClient.prototype, "repositoryToken").mockResolvedValue({
    token: "token",
    path: "/repos/octo/repo",
    installationId: 10,
    repositoryId: 1000,
  });
  const request = vi
    .spyOn(GitHubAppClient.prototype, "request")
    .mockImplementation(async (_token, path) => {
      if (path.includes("/actions/runs?")) return { total_count: 0, workflow_runs: [] };
      if (path.includes("/actions/runs/9/jobs?"))
        return { total_count: 1, jobs: [{ ...job, id: 8, run_id: 9 }] };
      if (path.endsWith("/actions/runs/9"))
        return {
          id: 9,
          run_attempt: 1,
          repository: { id: 1000 },
          actor: { id: 100 },
          triggering_actor: { id: 101 },
        };
      throw new Error(`Unexpected request ${path}`);
    });
  const result = await machineRequest("/machine/jobs/scan", machine.bearer, {
    bindingId: binding.id,
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ runs: 1, jobs: 1, complete: true });
  expect(request).toHaveBeenCalledTimes(4);
  expect(await env.DB.prepare("SELECT actorId, triggeringActorId FROM githubJobs").first()).toEqual(
    { actorId: 100, triggeringActorId: 101 },
  );
});

it("does not persist refreshed jobs after binding revocation", async () => {
  const { machine, binding } = await fixture();
  await seedApp();
  const { GitHubAppClient } = await import("../../../packages/github/src/app-client.js");
  vi.spyOn(GitHubAppClient.prototype, "repositoryToken").mockResolvedValue({
    token: "token",
    path: "/repos/octo/repo",
    installationId: 10,
    repositoryId: 1000,
  });
  vi.spyOn(GitHubAppClient.prototype, "request").mockImplementation(async () => {
    await env.DB.prepare("UPDATE repositoryBindings SET enabled = 0 WHERE id = ?")
      .bind(binding.id)
      .run();
    return job;
  });
  expect(
    (
      await machineRequest("/machine/jobs/refresh", machine.bearer, {
        bindingId: binding.id,
        jobId: 4,
      })
    ).status,
  ).toBe(403);
  expect(await env.DB.prepare("SELECT * FROM githubJobs").first()).toBeNull();
});

it("keeps unavailable running logs pending and rejects logs from another repository", async () => {
  const { machine, binding } = await fixture();
  await seedApp();
  const { GitHubAppClient, GitHubApiError } =
    await import("../../../packages/github/src/app-client.js");
  vi.spyOn(GitHubAppClient.prototype, "repositoryToken").mockResolvedValue({
    token: "token",
    path: "/repos/octo/repo",
    installationId: 10,
    repositoryId: 1000,
  });
  let repositoryId = 1000;
  vi.spyOn(GitHubAppClient.prototype, "request").mockImplementation(async (_token, path) =>
    path.endsWith("/actions/jobs/4") ? job : { id: 5, repository: { id: repositoryId } },
  );
  const download = vi
    .spyOn(GitHubAppClient.prototype, "downloadJobLog")
    .mockRejectedValue(new GitHubApiError(404));
  const result = await machineRequest("/machine/jobs/logs", machine.bearer, {
    bindingId: binding.id,
    jobId: 4,
    after: 20,
  });
  expect(await result.json()).toEqual({
    text: "",
    next: 20,
    status: "in_progress",
    complete: false,
    truncated: false,
  });
  repositoryId = 2000;
  expect(
    (
      await machineRequest("/machine/jobs/logs", machine.bearer, {
        bindingId: binding.id,
        jobId: 4,
      })
    ).status,
  ).toBe(403);
  expect(download).toHaveBeenCalledTimes(1);
});

it("rechecks authorization after downloading logs", async () => {
  const { machine, binding } = await fixture();
  await seedApp();
  const { GitHubAppClient, GitHubApiError } =
    await import("../../../packages/github/src/app-client.js");
  vi.spyOn(GitHubAppClient.prototype, "repositoryToken").mockResolvedValue({
    token: "token",
    path: "/repos/octo/repo",
    installationId: 10,
    repositoryId: 1000,
  });
  vi.spyOn(GitHubAppClient.prototype, "request").mockImplementation(async (_token, path) =>
    path.endsWith("/actions/jobs/4") ? job : { id: 5, repository: { id: 1000 } },
  );
  vi.spyOn(GitHubAppClient.prototype, "downloadJobLog").mockImplementation(async () => {
    await env.DB.prepare("UPDATE repositoryBindings SET enabled = 0 WHERE id = ?")
      .bind(binding.id)
      .run();
    throw new GitHubApiError(404);
  });
  expect(
    (
      await machineRequest("/machine/jobs/logs", machine.bearer, {
        bindingId: binding.id,
        jobId: 4,
      })
    ).status,
  ).toBe(403);
});
