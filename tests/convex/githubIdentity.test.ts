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
beforeEach(() => vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", identity.issuer));
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
  await expect(t.action(api.githubOAuth.begin, {})).rejects.toThrow();
  const owner = t.withIdentity(identity);
  const { url } = await owner.action(api.githubOAuth.begin, {});
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
  expect((await t.fetch(path)).status).toBe(303);
  expect((await t.fetch(path)).status).toBe(403);
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
  await expect(stranger.mutation(api.githubIdentity.confirm, { id })).rejects.toThrow();
  await owner.mutation(api.githubIdentity.confirm, { id });
  expect((await owner.query(api.githubIdentity.list, {})).accounts[0]?.githubId).toBe(71);
  expect(await t.run((ctx) => ctx.db.query("githubLinks").collect())).toEqual([]);
});
test("expired state and exchange failure never link an account or retry an OAuth code", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  const { url } = await owner.action(api.githubOAuth.begin, {});
  const state = new URL(url).searchParams.get("state");
  const fetch = vi.fn(async () => Response.json({ error: "bad_verification_code" }));
  vi.stubGlobal("fetch", fetch);
  expect((await t.fetch(`/github/oauth/callback?state=${state}&code=bad`)).status).toBe(502);
  expect((await t.fetch(`/github/oauth/callback?state=${state}&code=bad`)).status).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await owner.query(api.githubIdentity.list, {})).accounts).toEqual([]);
  const { url: expired } = await owner.action(api.githubOAuth.begin, {});
  await t.run(async (ctx) => {
    for (const link of await ctx.db.query("githubLinks").collect())
      await ctx.db.patch("githubLinks", link._id, { expiresAt: Date.now() - 1 });
  });
  expect(
    (
      await t.fetch(
        `/github/oauth/callback?state=${new URL(expired).searchParams.get("state")}&code=code`,
      )
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("cancelled confirmation cannot be completed by a late callback", async () => {
  const t = await setup();
  const owner = t.withIdentity(identity);
  await owner.action(api.githubOAuth.begin, {});
  const link = await t.run((ctx) => ctx.db.query("githubLinks").first());
  expect(link).not.toBeNull();
  const claim = await t.mutation(internal.githubIdentity.claim, { digest: link!.digest });
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
  expect(response.headers.get("Location")).toBe("https://vectis.kerd.dev/connect?github=1");
  expect(fetch).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("githubAccounts").collect())).toEqual([]);
});
