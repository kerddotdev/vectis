import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env, seedApp, stubFetch } from "../src/test-support.js";
import { sweepRedelivery } from "../src/github/redelivery.js";
const now = Date.now();
const row = (id: string, guid: string, status = 500, age = 120000) => ({
  id,
  guid,
  status_code: status,
  event: "workflow_job",
  delivered_at: new Date(now - age).toISOString(),
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM githubApps"),
    env.DB.prepare("DELETE FROM githubRedeliveryCheckpoint"),
    env.DB.prepare("DELETE FROM githubRedeliveryRequests"),
  ]);
});
afterEach(() => vi.restoreAllMocks());
it("reserves failed GUIDs once, preserves large IDs and advances only forward", async () => {
  await seedApp();
  const posts: string[] = [];
  stubFetch((request) => {
    if (request.method === "POST") {
      posts.push(request.url);
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify([
        row("9007199254740993999", "failed"),
        row("2", "success", 200),
        row("3", "fresh", 500, 10000),
      ]).replace('"9007199254740993999"', "9007199254740993999"),
    );
  });
  await sweepRedelivery(env, now);
  await sweepRedelivery(env, now);
  expect(posts).toEqual([
    "https://api.github.com/app/hook/deliveries/9007199254740993999/attempts",
  ]);
  expect(
    await env.DB.prepare("SELECT deliveredAt FROM githubRedeliveryCheckpoint").first(),
  ).toEqual({ deliveredAt: now - 60000 });
});
it("leaves the checkpoint unchanged on an incomplete listing or failed POST", async () => {
  await seedApp();
  const fetch = stubFetch(() => new Response(null, { status: 503 }));
  await sweepRedelivery(env, now);
  expect(await env.DB.prepare("SELECT * FROM githubRedeliveryCheckpoint").first()).toBeNull();
  fetch.mockRestore();
  stubFetch((request) =>
    request.method === "POST"
      ? new Response(null, { status: 500 })
      : Response.json([row("1", "failed")]),
  );
  await sweepRedelivery(env, now);
  expect(await env.DB.prepare("SELECT * FROM githubRedeliveryCheckpoint").first()).toBeNull();
  expect(await env.DB.prepare("SELECT guid FROM githubRedeliveryRequests").first()).toEqual({
    guid: "failed",
  });
});
it("bounds pagination and leaves the checkpoint unchanged when not complete", async () => {
  await seedApp();
  const fetch = stubFetch(() =>
    Response.json([row("1", "failed")], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
    }),
  );
  await sweepRedelivery(env, now);
  expect(fetch).toHaveBeenCalledTimes(10);
  expect(await env.DB.prepare("SELECT * FROM githubRedeliveryCheckpoint").first()).toBeNull();
});
