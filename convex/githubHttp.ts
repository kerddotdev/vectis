import { Schema } from "effect";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { appManifest } from "../packages/github/src/manifest.js";
import { smallJson } from "./httpBody.js";

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
export const setup = httpAction(async (ctx, request) => {
  const state = await stateDigest(request);
  const owner = state
    ? await ctx.runQuery(internal.githubAppSetup.inspect, { stateDigest: state.digest })
    : null;
  if (!state || !owner)
    return new Response("This setup link is invalid or expired.", { status: 403 });
  const manifest = appManifest(
    "Vectis by kerd.dev [DEV]",
    "https://vectis.kerd.dev",
    "https://vectis.kerd.dev",
  );
  manifest.hook_attributes.url = "https://vectis.kerd.dev/api/github/webhook";
  manifest.redirect_url = "https://vectis.kerd.dev/api/github/manifest/callback";
  manifest.callback_urls = ["https://vectis.kerd.dev/api/github/oauth/callback"];
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><title>Register Vectis by kerd.dev [DEV]</title><style>body{background:#15191e;color:#e6e9ee;font:18px/1.6 system-ui;max-width:650px;margin:12vh auto;padding:24px}button{background:#b9d7fe;color:#182638;padding:16px;border:0;border-radius:8px;font:inherit;cursor:pointer}</style></head><body><h1>Register Vectis by <a href="https://kerd.dev" style="color:inherit">kerd.dev</a> [DEV]</h1><p>Continue with the configured GitHub owner account. App credentials are stored only in the Vectis backend.</p><form action="https://github.com/settings/apps/new?state=${state.state}" method="post"><input type="hidden" name="manifest" value="${escaped(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form></body></html>`,
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
});
export const manifestCallback = httpAction(async (ctx, request) => {
  const state = await stateDigest(request);
  const code = new URL(request.url).searchParams.get("code");
  if (!state || !code || !/^[A-Za-z0-9_-]{1,200}$/.test(code))
    return new Response("Invalid callback.", { status: 400 });
  const expected = await ctx.runQuery(internal.githubAppSetup.inspect, {
    stateDigest: state.digest,
  });
  if (!expected) return new Response("This setup link is invalid or expired.", { status: 403 });
  try {
    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
        redirect: "error",
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
    const app = Schema.decodeUnknownSync(App)(await smallJson(response, 65536));
    if (app.owner.id !== expected.ownerId)
      return new Response("This app belongs to a different GitHub owner. It was not connected.", {
        status: 403,
      });
    await ctx.runMutation(internal.githubAppSetup.save, {
      stateDigest: state.digest,
      appId: app.id,
      slug: app.slug,
      ownerId: app.owner.id,
      clientId: app.client_id,
      privateKey: app.pem,
      clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret,
    });
    return new Response("The GitHub App is registered. You can close this tab.", {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch {
    return new Response(
      "Registration could not be confirmed. Check the GitHub App before retrying; no secrets are displayed here.",
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
});
