import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { Schema } from "effect";
import { MigrationAnalysis } from "../../../packages/protocol/src/migrations.js";
import {
  env,
  seedMachine,
  seedAccount,
  seedBinding,
  seedApp,
  readyLinux,
  stubFetch,
} from "../src/test-support.js";
import { newId } from "../src/ids.js";

beforeEach(async () => {
  await env.DB.batch(
    ["machines", "githubAccounts", "githubApps", "githubJobs"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());
const sha = "a".repeat(40);
const revision = "a".repeat(64);
const before =
  "on: push\njobs:\n  build:\n    runs-on: ubuntu-24.04-arm\n  hosted:\n    runs-on: macos-26\n";
async function fixture() {
  const machine = await seedMachine({ environments: [{ ...readyLinux(), revision }] });
  const account = await seedAccount(machine.owner);
  const binding = await seedBinding({
    owner: machine.owner,
    machineId: machine.id,
    accountId: account.id,
  });
  await seedApp();
  const state = {
    truncated: false,
    installationId: 10,
    changedBase: false,
    published: false,
    beforeToken: undefined as (() => Promise<void>) | undefined,
    tokenStatus: 200,
  };
  const posts: { path: string; body: unknown }[] = [];
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/installation"))
      return Response.json({
        id: state.installationId,
        app_id: 1,
        account: { id: 100, type: "User" },
        suspended_at: null,
      });
    if (path.endsWith("/access_tokens")) {
      await state.beforeToken?.();
      return state.tokenStatus === 200
        ? Response.json({ token: "migration-token" })
        : Response.json(
            { message: "Resource not accessible by integration" },
            { status: state.tokenStatus },
          );
    }
    if (path === "/repos/octo/repo")
      return Response.json({ id: 1000, owner: { id: 100 }, private: true, default_branch: "main" });
    if (path.endsWith("/fork-pr-workflows-private-repos"))
      return Response.json({
        run_workflows_from_fork_pull_requests: false,
        require_approval_for_fork_pr_workflows: true,
      });
    if (request.method === "POST") {
      posts.push({ path, body: await request.json() });
      if (path.endsWith("/git/trees")) return Response.json({ sha: "e".repeat(40) });
      if (path.endsWith("/git/commits")) return Response.json({ sha: "f".repeat(40) });
      if (path.endsWith("/git/refs")) {
        state.published = true;
        return Response.json({});
      }
      if (path.endsWith("/pulls"))
        return Response.json({
          number: 12,
          state: "open",
          html_url: "https://github.com/octo/repo/pull/12",
          head: { repo: { id: 1000 } },
        });
    }
    if (path.endsWith("/pulls")) return Response.json([]);
    if (path.endsWith("/git/ref/heads/main"))
      return Response.json({ object: { sha: state.changedBase ? "b".repeat(40) : sha } });
    if (path.endsWith("/git/ref/heads/vectis/migrate-workflows"))
      return state.published
        ? Response.json({ object: { sha: "f".repeat(40) } })
        : new Response(null, { status: 404 });
    if (path.endsWith(`/git/commits/${"f".repeat(40)}`))
      return Response.json({
        tree: { sha: "e".repeat(40) },
        parents: [{ sha }],
        message: `Migrate workflows to Vectis (${"e".repeat(40)})`,
      });
    if (path.endsWith(`/git/commits/${sha}`))
      return Response.json({ tree: { sha }, parents: [], message: "base" });
    if (path.endsWith(`/git/trees/${sha}`))
      return Response.json({
        truncated: state.truncated,
        tree: [{ path: ".github", type: "tree", mode: "040000", sha: "b".repeat(40) }],
      });
    if (path.endsWith(`/git/trees/${"b".repeat(40)}`))
      return Response.json({
        truncated: false,
        tree: [{ path: "workflows", type: "tree", mode: "040000", sha: "c".repeat(40) }],
      });
    if (path.endsWith(`/git/trees/${"c".repeat(40)}`))
      return Response.json({
        truncated: false,
        tree: [{ path: "ci.yml", type: "blob", mode: "100644", sha: "d".repeat(40) }],
      });
    if (path.endsWith(`/git/blobs/${"d".repeat(40)}`))
      return Response.json({
        sha: "d".repeat(40),
        encoding: "base64",
        content: btoa(before),
        size: before.length,
      });
    throw new Error(`Unexpected GitHub request ${path}`);
  });
  async function request(path: string, body: unknown, bearer = machine.bearer) {
    return worker.fetch(
      new Request(`https://cloud.test/machine/migrations/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      createExecutionContext(),
    );
  }
  async function analyze() {
    const response = await request("analyze", { bindingId: binding.id });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(MigrationAnalysis)(await response.json());
  }
  async function verify(phase = "released", runnerId = 6, environmentRevision = revision) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runnerLeases (id, owner, machineId, bindingId, environmentId, os, key, environmentRevision, phase, runnerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'linux', 'linux', 'verify', ?, ?, ?, 1, 1)`,
      ).bind(newId(), machine.owner, machine.id, binding.id, environmentRevision, phase, runnerId),
      env.DB.prepare(
        `INSERT INTO githubJobs (installationId, repositoryId, jobId, runId, name, status, conclusion, labelsJson, runnerId, updatedAt) VALUES (10, 1000, 4, 5, 'test', 'completed', 'success', '[]', 6, 1)`,
      ),
    ]);
  }
  return { machine, binding, state, posts, request, analyze, verify };
}
it("analyzes pinned workflows and retains job summaries", async () => {
  const f = await fixture();
  const analysis = await f.analyze();
  expect(analysis.verified).toBe(false);
  expect(analysis.files[0]?.after).toBe(before.replace("ubuntu-24.04-arm", "vectis-linux"));
  const row = await env.DB.prepare("SELECT * FROM migrationPreviews WHERE id = ?")
    .bind(analysis.previewId)
    .first<{ reportJson: string; expiresAt: number; createdAt: number }>();
  expect(row?.expiresAt).toBe((row?.createdAt ?? 0) + 86400000);
  expect(JSON.parse(row?.reportJson ?? "{}").files[0].jobs).toEqual(analysis.files[0]?.jobs);
});
it("requires authentication and owned bindings", async () => {
  const f = await fixture();
  expect((await f.request("analyze", { bindingId: f.binding.id }, "invalid")).status).toBe(401);
  const other = await seedMachine();
  const response = await f.request("analyze", { bindingId: f.binding.id }, other.bearer);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "repository_access_denied" });
});
it.each(["missing", "expired", "foreign", "environment"])(
  "rejects %s previews",
  async (scenario) => {
    const f = await fixture();
    let previewId = newId();
    if (scenario !== "missing") previewId = (await f.analyze()).previewId;
    if (scenario === "expired")
      await env.DB.prepare("UPDATE migrationPreviews SET expiresAt = 1").run();
    if (scenario === "foreign")
      await env.DB.prepare("UPDATE migrationPreviews SET owner = 'other'").run();
    if (scenario === "environment")
      await env.DB.prepare("UPDATE migrationPreviews SET environmentRevision = 'other'").run();
    const response = await f.request("publish", { previewId });
    expect(await response.json()).toMatchObject({
      code:
        scenario === "environment"
          ? "migration_environment_changed"
          : "migration_preview_unavailable",
    });
    expect(f.posts).toHaveLength(0);
  },
);
it.each(["ready", "wrong-runner", "old-revision"])(
  "refuses publication with %s runner evidence",
  async (scenario) => {
    const f = await fixture();
    const { previewId } = await f.analyze();
    await f.verify(
      scenario === "ready" ? "ready" : "released",
      scenario === "wrong-runner" ? 99 : 6,
      scenario === "old-revision" ? "b".repeat(64) : revision,
    );
    const response = await f.request("publish", { previewId });
    expect(await response.json()).toMatchObject({ code: "environment_not_verified" });
    expect(f.posts).toHaveLength(0);
  },
);
it("publishes changed workflows after a successful job and runner cleanup", async () => {
  const f = await fixture();
  await f.verify();
  const analysis = await f.analyze();
  expect(analysis.verified).toBe(true);
  const response = await f.request("publish", { previewId: analysis.previewId });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "created", number: 12 });
  expect(f.posts.find((post) => post.path.endsWith("/pulls"))?.body).toMatchObject({
    draft: false,
    base: "main",
  });
});
it("rejects unchanged previews before GitHub publication", async () => {
  const f = await fixture();
  await f.verify();
  const { previewId } = await f.analyze();
  const row = await env.DB.prepare("SELECT reportJson FROM migrationPreviews WHERE id = ?")
    .bind(previewId)
    .first<{ reportJson: string }>();
  const report = JSON.parse(row?.reportJson ?? "{}");
  report.files.forEach((file: { changed: boolean }) => {
    file.changed = false;
  });
  await env.DB.prepare("UPDATE migrationPreviews SET reportJson = ? WHERE id = ?")
    .bind(JSON.stringify(report), previewId)
    .run();
  expect(await (await f.request("publish", { previewId })).json()).toMatchObject({
    code: "migration_no_changes",
  });
  expect(f.posts).toHaveLength(0);
});
it("rechecks preview authority after minting publication credentials", async () => {
  const f = await fixture();
  await f.verify();
  const { previewId } = await f.analyze();
  f.state.beforeToken = async () => {
    await env.DB.prepare("UPDATE repositoryBindings SET enabled = 0").run();
  };
  expect(await (await f.request("publish", { previewId })).json()).toMatchObject({
    code: "repository_access_denied",
  });
  expect(f.posts).toHaveLength(0);
});
it("rejects changed installations", async () => {
  const f = await fixture();
  f.state.installationId = 11;
  expect(await (await f.request("analyze", { bindingId: f.binding.id })).json()).toMatchObject({
    code: "installation_changed",
  });
});
it("preserves token permission recovery codes", async () => {
  const f = await fixture();
  f.state.tokenStatus = 403;
  expect(await (await f.request("analyze", { bindingId: f.binding.id })).json()).toMatchObject({
    code: "repository_access_denied",
  });
});
it("refuses truncated inventories with a useful error", async () => {
  const f = await fixture();
  f.state.truncated = true;
  expect(await (await f.request("analyze", { bindingId: f.binding.id })).json()).toMatchObject({
    code: "workflow_inventory_incomplete",
  });
});
it("refuses stale publication bases", async () => {
  const f = await fixture();
  await f.verify();
  const { previewId } = await f.analyze();
  f.state.changedBase = true;
  expect(await (await f.request("publish", { previewId })).json()).toMatchObject({
    code: "migration_stale",
  });
  expect(f.posts).toHaveLength(0);
});

it("caps active previews while allowing expired previews to remain stored", async () => {
  const f = await fixture();
  const { previewId } = await f.analyze();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 99)
    INSERT INTO migrationPreviews (id, owner, machineId, bindingId, reportJson, environmentRevision, createdAt, expiresAt)
    SELECT id || '-' || x, owner, machineId, bindingId, reportJson, environmentRevision, createdAt, expiresAt FROM migrationPreviews, n WHERE id = ?`)
    .bind(previewId)
    .run();
  expect(await (await f.request("analyze", { bindingId: f.binding.id })).json()).toMatchObject({
    code: "migration_preview_limit",
  });
  await env.DB.prepare("UPDATE migrationPreviews SET expiresAt = 1").run();
  await f.analyze();
  expect(await env.DB.prepare("SELECT count(*) AS total FROM migrationPreviews").first()).toEqual({
    total: 101,
  });
});
it("invalidates analysis when the prepared environment changes during GitHub access", async () => {
  const f = await fixture();
  f.state.beforeToken = async () => {
    await env.DB.prepare("UPDATE machines SET environmentsJson = ? WHERE id = ?")
      .bind(JSON.stringify([{ ...readyLinux(), revision: "b".repeat(64) }]), f.machine.id)
      .run();
  };
  expect(await (await f.request("analyze", { bindingId: f.binding.id })).json()).toMatchObject({
    code: "migration_environment_changed",
  });
  expect(await env.DB.prepare("SELECT count(*) AS total FROM migrationPreviews").first()).toEqual({
    total: 0,
  });
});
it("rechecks expiry immediately before publication", async () => {
  const f = await fixture();
  await f.verify();
  const { previewId } = await f.analyze();
  f.state.beforeToken = async () => {
    await env.DB.prepare("UPDATE migrationPreviews SET expiresAt = 1").run();
  };
  expect(await (await f.request("publish", { previewId })).json()).toMatchObject({
    code: "migration_preview_unavailable",
  });
  expect(f.posts).toHaveLength(0);
});
it("revoked machines cannot publish retained previews", async () => {
  const f = await fixture();
  const { previewId } = await f.analyze();
  await env.DB.prepare("DELETE FROM machines WHERE id = ?").bind(f.machine.id).run();
  expect((await f.request("publish", { previewId })).status).toBe(401);
});
