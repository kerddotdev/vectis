import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
const modules = {
  "../../convex/githubIdentity.ts": () => import("../../convex/githubIdentity.js"),
  "../../convex/githubOAuth.ts": () => import("../../convex/githubOAuth.js"),
  "../../convex/http.ts": () => import("../../convex/http.js"),
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
};
const identity = {
  issuer: "https://clerk.test",
  subject: "owner",
  tokenIdentifier: "https://clerk.test|owner",
};
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", identity.issuer);
  vi.stubEnv("VECTIS_WEB_URL", "https://vectis.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function setup() {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("githubApps", {
      appId: 42,
      slug: "test",
      ownerId: 1,
      clientId: "client",
      clientSecret: "client-secret",
      privateKey: "private",
      webhookSecret: "webhook",
    }),
  );
  return t;
}
async function begin(owner: ReturnType<Awaited<ReturnType<typeof setup>>["withIdentity"]>) {
  const response = await owner.fetch("/github/oauth/begin", {
    method: "POST",
    headers: { Origin: "https://vectis.test" },
  });
  expect(response.status).toBe(200);
  const body: { url: string } = await response.json();
  const header = response.headers.get("Set-Cookie")!;
  expect(header).toMatch(/Secure; HttpOnly; SameSite=Lax/);
  return { url: body.url, cookie: header.split(";")[0]! };
}
async function confirm(
  owner: ReturnType<Awaited<ReturnType<typeof setup>>["withIdentity"]>,
  id: string,
  cookie: string,
) {
  return owner.fetch("/github/oauth/confirm", {
    method: "POST",
    headers: { Origin: "https://vectis.test", Cookie: cookie },
    body: JSON.stringify({ id }),
  });
}
function github() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://github.com/login/oauth/access_token") {
      expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toHaveLength(43);
      return Response.json({ access_token: "user-secret", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user")
      return Response.json({ id: 71, login: "verified-user" });
    if (url.startsWith("https://api.github.com/user/installations?"))
      return Response.json({
        total_count: 3,
        installations: [
          { id: 100, app_id: 42, account: { id: 71, login: "verified-user" }, suspended_at: null },
          { id: 101, app_id: 99, account: { id: 72, login: "other-app" }, suspended_at: null },
          {
            id: 102,
            app_id: 42,
            account: { id: 73, login: "suspended" },
            suspended_at: "2026-01-01",
          },
        ],
      });
    throw new Error("Unexpected request");
  });
}
test("OAuth binds PKCE and owner confirmation, filters installations, and exposes no credentials", async () => {
  const t = await setup();
  expect(
    (
      await t.fetch("/github/oauth/begin", {
        method: "POST",
        headers: { Origin: "https://vectis.test" },
      })
    ).status,
  ).toBe(400);
  const owner = t.withIdentity(identity);
  const { url, cookie } = await begin(owner);
  const params = new URL(url).searchParams;
  expect(params.get("code_challenge_method")).toBe("S256");
  const record = await t.run((ctx) => ctx.db.query("githubLinks").first());
  expect(
    createHash("sha256")
      .update(record?.verifier ?? "")
      .digest("base64url"),
  ).toBe(params.get("code_challenge"));
  const fetch = github();
  vi.stubGlobal("fetch", fetch);
  const path = `/github/oauth/callback?state=${params.get("state")}&code=code`;
  const callback = await t.fetch(path, { headers: { Cookie: cookie } });
  expect(callback.status).toBe(303);
  const completion = callback.headers.get("Set-Cookie")!.split(";")[0]!;
  expect((await t.fetch(path, { headers: { Cookie: cookie } })).status).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(3);
  const review = await owner.query(api.githubIdentity.list, {});
  expect(review.accounts).toEqual([]);
  expect(review.pending[0]?.user?.installations).toEqual([
    { id: 100, accountId: 71, login: "verified-user" },
  ]);
  expect(JSON.stringify(review)).not.toMatch(/user-secret|client-secret|verifier|digest/);
  const id = review.pending[0]!.id;
  const stranger = t.withIdentity({
    ...identity,
    tokenIdentifier: "https://clerk.test|stranger",
    subject: "stranger",
  });
  expect(await stranger.query(api.githubIdentity.list, {})).toEqual({ accounts: [], pending: [] });
  expect((await confirm(stranger, id, `${cookie}; ${completion}`)).status).toBe(400);
  expect((await confirm(owner, id, cookie)).status).toBe(403);
  const otherBrowser = await begin(owner);
  expect((await confirm(owner, id, `${otherBrowser.cookie}; ${completion}`)).status).toBe(400);
  await owner.mutation(api.githubIdentity.discard, {
    id: (await owner.query(api.githubIdentity.list, {})).pending.find((link) => link.id !== id)!.id,
  });
  expect((await confirm(owner, id, `${cookie}; ${completion}`)).status).toBe(200);
  expect((await confirm(owner, id, `${cookie}; ${completion}`)).status).toBe(400);
  expect((await owner.query(api.githubIdentity.list, {})).accounts[0]?.githubId).toBe(71);
  expect(await t.run((ctx) => ctx.db.query("githubLinks").collect())).toEqual([]);
});
test("expired state and exchange failure never link an account or retry an OAuth code", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  const { url, cookie } = await begin(owner);
  const state = new URL(url).searchParams.get("state");
  const fetch = vi.fn(async () => Response.json({ error: "bad_verification_code" }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await t.fetch(`/github/oauth/callback?state=${state}&code=bad`, {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(502);
  expect(
    (
      await t.fetch(`/github/oauth/callback?state=${state}&code=bad`, {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await owner.query(api.githubIdentity.list, {})).accounts).toEqual([]);
  const { url: expired, cookie: expiredCookie } = await begin(owner);
  await t.run(async (ctx) => {
    for (const link of await ctx.db.query("githubLinks").collect())
      await ctx.db.patch("githubLinks", link._id, { expiresAt: Date.now() - 1 });
  });
  expect(
    (
      await t.fetch(
        `/github/oauth/callback?state=${new URL(expired).searchParams.get("state")}&code=code`,
        { headers: { Cookie: expiredCookie } },
      )
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("cancelled confirmation cannot be completed by a late callback", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  await begin(owner);
  const link = await t.run((ctx) => ctx.db.query("githubLinks").first());
  expect(link).not.toBeNull();
  const claim = await t.mutation(internal.githubIdentity.claim, {
    digest: link!.digest,
    browserDigest: link!.browserDigest!,
  });
  await owner.mutation(api.githubIdentity.discard, { id: link!._id });
  await t.mutation(internal.githubIdentity.finish, {
    id: claim!.id,
    user: { id: 71, login: "verified", installations: [] },
  });
  expect(await owner.query(api.githubIdentity.list, {})).toEqual({ accounts: [], pending: [] });
});

test("direct installation callbacks require a fresh Vectis link instead of trusting installation parameters", async () => {
  const t = await setup();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const response = await t.fetch("/github/oauth/callback?code=unbound&installation_id=123");
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("https://vectis.test/connect?github=1");
  expect(fetch).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("githubAccounts").collect())).toEqual([]);
});

test("transferred authorization URLs cannot claim another browser's GitHub identity", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  const other = t.withIdentity({
    ...identity,
    subject: "other",
    tokenIdentifier: "https://clerk.test|other",
  });
  const initial = await begin(owner);
  const foreign = await begin(other);
  const path = `/github/oauth/callback?state=${new URL(initial.url).searchParams.get("state")}&code=victim`;
  const fetch = github();
  vi.stubGlobal("fetch", fetch);
  expect((await t.fetch(path)).status).toBe(403);
  expect((await t.fetch(path, { headers: { Cookie: foreign.cookie } })).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await owner.query(api.githubIdentity.list, {})).pending[0]?.phase).toBe("pending");
  expect((await t.fetch(path, { headers: { Cookie: initial.cookie } })).status).toBe(303);
});

test("cross-origin linking and legacy unbound states fail closed", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  expect(
    (
      await owner.fetch("/github/oauth/begin", {
        method: "POST",
        headers: { Origin: "https://attacker.test" },
      })
    ).status,
  ).toBe(403);
  const { url, cookie } = await begin(owner);
  await t.run(async (ctx) => {
    const link = await ctx.db.query("githubLinks").first();
    await ctx.db.patch("githubLinks", link!._id, { browserDigest: undefined });
  });
  const fetch = github();
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await t.fetch(
        `/github/oauth/callback?state=${new URL(url).searchParams.get("state")}&code=code`,
        { headers: { Cookie: cookie } },
      )
    ).status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
