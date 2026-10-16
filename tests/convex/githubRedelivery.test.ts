import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { internal } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/githubRedelivery.ts": () => import("../../convex/githubRedelivery.js"),
  "../../convex/githubRedeliveryState.ts": () => import("../../convex/githubRedeliveryState.js"),
  "../../convex/retention.ts": () => import("../../convex/retention.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const minute = 60_000;
const day = 24 * 60 * minute;
const now = Date.parse("2026-10-16T12:00:00Z");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const delivery = (
  id: number,
  guid = `guid-${id}`,
  age = 2 * minute,
  status = 500,
  event = "workflow_job",
) => ({
  id,
  guid,
  delivered_at: new Date(Date.now() - age).toISOString(),
  status_code: status,
  status: status === 200 ? "OK" : "Internal Server Error",
  event,
  action: "queued",
  redelivery: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected unstubbed GitHub request.");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(rows: ReturnType<typeof delivery>[] = []) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 7,
      clientId: "test-client",
      privateKey,
      clientSecret: "test",
      webhookSecret: "test",
    });
  });
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? new Response(null, { status: 202 }) : Response.json(rows),
  );
  vi.stubGlobal("fetch", fetch);
  return {
    t,
    fetch,
    scan: () => t.action(internal.githubRedelivery.scan, {}),
    checkpoint: () => t.run((ctx) => ctx.db.query("githubRedeliveryCheckpoint").first()),
    requests: () => t.run((ctx) => ctx.db.query("githubRedeliveryRequests").collect()),
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}

test("redelivers a failed guid once using the App JWT and advances the checkpoint", async () => {
  const f = await fixture([delivery(2, "failed"), delivery(1, "failed", 3 * minute)]);
  await f.scan();
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]?.[0]).toBe("https://api.github.com/app/hook/deliveries/2/attempts");
  const headers = new Headers(f.fetch.mock.calls[0]?.[1]?.headers);
  const token = headers.get("Authorization")?.split(" ")[1];
  const payload = token?.split(".")[1];
  expect(payload && JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
    iss: "test-client",
    exp: now / 1000 + 300,
  });
  expect(await f.requests()).toMatchObject([{ guid: "failed", requestedAt: now }]);
  expect(await f.checkpoint()).toMatchObject({ deliveredAt: now - minute, scannedAt: now });
});

test("a later successful attempt suppresses redelivery across cursor pages", async () => {
  const f = await fixture();
  f.fetch.mockImplementation(async (url) => {
    const cursor = new URL(url).searchParams.get("cursor");
    if (cursor === null)
      return Response.json([delivery(2, "recovered", 2 * minute, 200)], {
        headers: {
          link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=opaque%2Bnext>; rel="next"',
        },
      });
    expect(cursor).toBe("opaque+next");
    return Response.json([delivery(1, "recovered", 3 * minute)]);
  });
  await f.scan();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.posts()).toHaveLength(0);
  expect(await f.requests()).toHaveLength(0);
});

test("any 2xx attempt suppresses redelivery, even when the newest attempt failed", async () => {
  const f = await fixture([delivery(2, "recovered"), delivery(1, "recovered", 3 * minute, 204)]);
  await f.scan();
  expect(f.posts()).toHaveLength(0);
});

test("fresh failures stay eligible for the next scan", async () => {
  const row = delivery(1, "fresh", 30_000);
  const f = await fixture([row]);
  await f.scan();
  expect(f.posts()).toHaveLength(0);
  expect(await f.checkpoint()).toMatchObject({ deliveredAt: now - minute });
  vi.setSystemTime(now + 2 * minute);
  await f.scan();
  expect(f.posts()).toHaveLength(1);
});

test.each([403, 429, 500, 503])("listing failure %s preserves the checkpoint", async (status) => {
  const f = await fixture();
  await f.scan();
  const checkpoint = await f.checkpoint();
  vi.setSystemTime(now + 2 * minute);
  f.fetch.mockResolvedValue(Response.json({ message: "Unavailable" }, { status }));
  await f.scan();
  expect(await f.checkpoint()).toEqual(checkpoint);
  expect(f.posts()).toHaveLength(0);
  expect(console.warn).toHaveBeenCalled();
});

test("a later page failure makes no requests and creates no checkpoint", async () => {
  const f = await fixture();
  f.fetch
    .mockResolvedValueOnce(
      Response.json([delivery(1)], {
        headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
      }),
    )
    .mockRejectedValueOnce(new Error("Network unavailable"));
  await f.scan();
  expect(await f.checkpoint()).toBeNull();
  expect(await f.requests()).toHaveLength(0);
});

test("guid dedupe survives repeated scans and new failed delivery IDs", async () => {
  const f = await fixture([delivery(1, "failed")]);
  await f.scan();
  vi.setSystemTime(now + 2 * minute);
  f.fetch.mockImplementation(async (_url, init) =>
    init?.method === "POST"
      ? new Response(null, { status: 202 })
      : Response.json([delivery(2, "failed")]),
  );
  await f.scan();
  expect(f.posts()).toHaveLength(1);
  expect(await f.requests()).toHaveLength(1);
});

test("concurrent claims cannot both request redelivery for one guid", async () => {
  const f = await fixture();
  const claims = await Promise.all([
    f.t.mutation(internal.githubRedeliveryState.claim, { guid: "same" }),
    f.t.mutation(internal.githubRedeliveryState.claim, { guid: "same" }),
  ]);
  expect(claims.sort()).toEqual([false, true]);
  expect(await f.requests()).toHaveLength(1);
});

test("no configured App means no fetch and no checkpoint", async () => {
  const t = convexTest(schema, modules);
  await t.action(internal.githubRedelivery.scan, {});
  expect(fetch).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("githubRedeliveryCheckpoint").first())).toBeNull();
  expect(console.warn).not.toHaveBeenCalled();
});

test("only Vectis events within the initial one-hour window are redelivered", async () => {
  const f = await fixture([
    delivery(6, "unsupported", minute, 500, "push"),
    ...["workflow_job", "installation", "installation_repositories", "repository"].map(
      (event, index) => delivery(5 - index, event, 2 * minute, 500, event),
    ),
    delivery(1, "too-old", 61 * minute),
  ]);
  await f.scan();
  expect((await f.requests()).map((row) => row.guid).sort()).toEqual([
    "installation",
    "installation_repositories",
    "repository",
    "workflow_job",
  ]);
});

test("stale checkpoints never extend eligibility beyond three days", async () => {
  const f = await fixture([delivery(2, "eligible", 2 * day), delivery(1, "expired", 4 * day)]);
  await f.t.run((ctx) =>
    ctx.db.insert("githubRedeliveryCheckpoint", {
      deliveredAt: now - 5 * day,
      scannedAt: now - 5 * day,
    }),
  );
  await f.scan();
  expect(await f.requests()).toMatchObject([{ guid: "eligible" }]);
});

test("scanning stops at the checkpoint without fetching the next page", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.insert("githubRedeliveryCheckpoint", {
      deliveredAt: now - 3 * minute,
      scannedAt: now - 2 * minute,
    }),
  );
  f.fetch.mockResolvedValue(
    Response.json([delivery(1, "old", 4 * minute)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
    }),
  );
  await f.scan();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.posts()).toHaveLength(0);
});

test("the redelivery limit drains remaining guids on a later run without skipping them", async () => {
  const f = await fixture(Array.from({ length: 25 }, (_, index) => delivery(index + 1)));
  await f.scan();
  expect(f.posts()).toHaveLength(20);
  expect(await f.checkpoint()).toBeNull();
  await f.scan();
  expect(f.posts()).toHaveLength(25);
  expect(await f.requests()).toHaveLength(25);
  expect(await f.checkpoint()).not.toBeNull();
});

test("the page limit preserves the checkpoint rather than skipping unseen attempts", async () => {
  const f = await fixture();
  f.fetch.mockImplementation(async () =>
    Response.json([delivery(1)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
    }),
  );
  await f.scan();
  expect(f.fetch).toHaveBeenCalledTimes(10);
  expect(await f.checkpoint()).toBeNull();
  expect(f.posts()).toHaveLength(0);
});

test("a POST error is logged and never repeated, including after an uncertain timeout", async () => {
  const f = await fixture([delivery(1)]);
  f.fetch.mockImplementation(async (_url, init) => {
    if (init?.method === "POST") throw new Error("Timed out after sending");
    return Response.json([delivery(1)]);
  });
  await f.scan();
  expect(await f.checkpoint()).toBeNull();
  await f.scan();
  expect(f.posts()).toHaveLength(1);
  expect(await f.checkpoint()).not.toBeNull();
  expect(console.warn).toHaveBeenCalled();
});

test("the action time budget leaves unrequested guids available for the next tick", async () => {
  const f = await fixture([delivery(1)]);
  f.fetch.mockImplementation(async () => {
    vi.setSystemTime(now + 90_000);
    return Response.json([delivery(1, "guid-1", 3 * minute)]);
  });
  await f.scan();
  expect(await f.requests()).toHaveLength(0);
  expect(await f.checkpoint()).toBeNull();
});

test("retention expires redelivery receipts after three days in bounded batches", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 501; index++)
      await ctx.db.insert("githubRedeliveryRequests", {
        guid: `old-${index}`,
        requestedAt: now - 3 * day - 1,
      });
    await ctx.db.insert("githubRedeliveryRequests", {
      guid: "boundary",
      requestedAt: now - 3 * day,
    });
    await ctx.db.insert("githubRedeliveryRequests", { guid: "recent", requestedAt: now });
  });
  await f.t.mutation(internal.retention.sweep, {});
  expect(await f.requests()).toHaveLength(3);
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await f.requests()).map((row) => row.guid).sort()).toEqual(["boundary", "recent"]);
});
