import { beforeEach, expect, it } from "vitest";
import { env, SELF, seedApp } from "../src/test-support.js";
import { githubWebhook } from "../src/github/webhook.js";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM githubApps"),
    env.DB.prepare("DELETE FROM githubDeliveries"),
    env.DB.prepare("DELETE FROM githubJobs"),
  ]);
});
async function send(body: string, event = "workflow_job", signature?: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return SELF.fetch("https://cloud.test/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      "x-hub-signature-256": signature ?? `sha256=${hex}`,
    },
  });
}
it("checks headers, bounded bodies, setup, signature, and payload", async () => {
  expect((await send("{}", "unknown")).status).toBe(400);
  expect((await send("x".repeat(1024 * 1024 + 1))).status).toBe(413);
  expect((await send("{}")).status).toBe(503);
  await seedApp();
  expect((await send("{}", "workflow_job", "bad")).status).toBe(401);
  expect((await send("invalid")).status).toBe(400);
  expect((await send("{}", "ping")).status).toBe(200);
});
it("deduplicates workflow jobs and strips unverified webhook actors", async () => {
  await seedApp();
  const payload = JSON.stringify({
    installation: { id: 10 },
    repository: { id: 100 },
    workflow_job: {
      id: 1,
      run_id: 2,
      name: "build",
      status: "in_progress",
      conclusion: null,
      labels: [],
      actor_id: 9,
      triggering_actor_id: 8,
    },
  });
  const first = await send(payload);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ accepted: true, duplicate: false });
  expect(await (await send(payload)).json()).toEqual({ accepted: true, duplicate: true });
  expect(await env.DB.prepare("SELECT actorId, triggeringActorId FROM githubJobs").first()).toEqual(
    { actorId: null, triggeringActorId: null },
  );
});

it("enriches restrictive bindings asynchronously using verified run actors", async () => {
  await seedApp();
  const { seedMachine, seedAccount, seedBinding } = await import("../src/test-support.js");
  const { GitHubAppClient } = await import("../../../packages/github/src/app-client.js");
  const { vi } = await import("vitest");
  const machine = await seedMachine();
  const account = await seedAccount(machine.owner);
  await seedBinding({
    owner: machine.owner,
    accountId: account.id,
    machineId: machine.id,
    repositoryId: 100,
    access: { actors: "any", approval: "required" },
  });
  const token = vi.spyOn(GitHubAppClient.prototype, "repositoryToken").mockResolvedValue({
    token: "token",
    path: "/repos/octo/repo",
    installationId: 10,
    repositoryId: 100,
  });
  const request = vi.spyOn(GitHubAppClient.prototype, "request").mockResolvedValue({
    id: 2,
    run_attempt: 1,
    repository: { id: 100 },
    actor: { id: 10 },
    triggering_actor: { id: 11 },
  });
  try {
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const body = JSON.stringify({
      installation: { id: 10 },
      repository: { id: 100 },
      workflow_job: {
        id: 3,
        run_id: 2,
        name: "build",
        status: "in_progress",
        conclusion: null,
        labels: [],
      },
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await githubWebhook(
      { env, ctx },
      new Request("https://cloud.test/github/webhook", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "workflow_job",
          "x-github-delivery": "enrich",
          "x-hub-signature-256": `sha256=${hex}`,
        },
      }),
    );
    await waitOnExecutionContext(ctx);
    expect(
      await env.DB.prepare(
        "SELECT actorId, triggeringActorId FROM githubJobs WHERE jobId = 3",
      ).first(),
    ).toEqual({ actorId: 10, triggeringActorId: 11 });
  } finally {
    token.mockRestore();
    request.mockRestore();
  }
});
