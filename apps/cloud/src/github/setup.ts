import { Schema } from "effect";
import type { RawHandler } from "../context.js";
import type { Env } from "../env.js";
import type { GitHubAppSetupRow } from "../db.js";
import { readJson } from "../http.js";
import { appManifest } from "../../../../packages/github/src/manifest.js";
import { githubUserAgent } from "../../../../packages/github/src/api-request.js";
import { appConfig, webhookUrl } from "./app.js";
async function inspect(env: Env, digest: string) {
  return env.DB.prepare(
    "SELECT * FROM githubAppSetups WHERE stateDigest = ? AND consumed = 0 AND expiresAt > ?",
  )
    .bind(digest, Date.now())
    .first<GitHubAppSetupRow>();
}
const App = Schema.Struct({
  id: Schema.Int,
  slug: Schema.NonEmptyString,
  owner: Schema.Struct({ id: Schema.Int }),
  client_id: Schema.NonEmptyString,
  pem: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  webhook_secret: Schema.NonEmptyString,
});
const escaped = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
async function stateDigest(request: Request) {
  const state = new URL(request.url).searchParams.get("state");
  if (!state || !/^[a-f0-9]{64}$/.test(state)) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return {
    state,
    digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
export const appSetup: RawHandler = async ({ env }, request) => {
  const state = await stateDigest(request);
  const owner = state ? await inspect(env, state.digest) : null;
  if (!state || !owner)
    return new Response("This setup link is invalid or expired.", { status: 403 });
  const site = env.VECTIS_WEB_URL;
  const app = appConfig(env);
  const manifest = appManifest(app.name, site, site, { public: app.public });
  manifest.hook_attributes.url = webhookUrl(env);
  manifest.redirect_url = `${site}/api/github/manifest/callback`;
  manifest.callback_urls = [`${site}/api/github/oauth/callback`];
  const title = escaped(app.name);
  const registration = owner.organization
    ? `https://github.com/organizations/${owner.ownerLogin}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><title>Register ${title}</title><style>body{background:#15191e;color:#e6e9ee;font:18px/1.6 system-ui;max-width:650px;margin:12vh auto;padding:24px}button{background:#b9d7fe;color:#182638;padding:16px;border:0;border-radius:8px;font:inherit;cursor:pointer}</style></head><body><h1>Register ${title}</h1><p>Continue with the configured GitHub owner account. App credentials are stored only in the Vectis backend.</p><form action="${registration}?state=${state.state}" method="post"><input type="hidden" name="manifest" value="${escaped(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'",
      },
    },
  );
};
export const manifestCallback: RawHandler = async ({ env }, request) => {
  const state = await stateDigest(request);
  const code = new URL(request.url).searchParams.get("code");
  if (!state || !code || !/^[A-Za-z0-9_-]{1,200}$/.test(code))
    return new Response("Invalid callback.", { status: 400 });
  const expected = await inspect(env, state.digest);
  if (!expected) return new Response("This setup link is invalid or expired.", { status: 403 });
  try {
    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": githubUserAgent,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return new Response(
        "GitHub could not complete registration. Inspect the app registration before retrying.",
        { status: 502 },
      );
    }
    const app = Schema.decodeUnknownSync(App)(await readJson(response, 65536));
    if (app.owner.id !== expected.ownerId)
      return new Response("This app belongs to a different GitHub owner. It was not connected.", {
        status: 403,
      });
    const saved = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO githubApps (singleton, appId, slug, ownerId, clientId, privateKey, clientSecret, webhookSecret) SELECT 1, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM githubAppSetups WHERE stateDigest = ? AND consumed = 0 AND expiresAt > ? AND ownerId = ?)`,
      ).bind(
        app.id,
        app.slug,
        app.owner.id,
        app.client_id,
        app.pem,
        app.client_secret,
        app.webhook_secret,
        state.digest,
        Date.now(),
        app.owner.id,
      ),
      env.DB.prepare(
        "UPDATE githubAppSetups SET consumed = 1 WHERE stateDigest = ? AND changes() = 1",
      ).bind(state.digest),
    ]);
    if (!saved[0]?.meta.changes)
      return new Response("This setup link is invalid or expired.", { status: 403 });
    return new Response("The GitHub App is registered. You can close this tab.", {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch {
    return new Response(
      "Registration could not be confirmed. Check the GitHub App before retrying; no secrets are displayed here.",
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
};
