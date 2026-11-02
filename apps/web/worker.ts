import type { ExportedHandler } from "@cloudflare/workers-types";

// Deploy scripts pass VECTIS_CONVEX_SITE with --var, so each deployment keeps its own backend.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  VECTIS_CONVEX_SITE: string;
}

const routes = new Map([
  ["/api/github/app/setup", "GET"],
  ["/api/github/manifest/callback", "GET"],
  ["/api/github/oauth/callback", "GET"],
  ["/api/github/oauth/begin", "POST"],
  ["/api/github/oauth/confirm", "POST"],
  ["/api/github/webhook", "POST"],
]);
const fallbackPolicy =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

async function serveAsset(request: Request, env: Env) {
  let response = await env.ASSETS.fetch(request);
  if (request.method !== "GET" && request.method !== "HEAD") return response;

  // Conditional and range responses cannot supply a fresh HTML document/CSP pair.
  if ([206, 304, 412, 416].includes(response.status)) {
    const headers = new Headers(request.headers);
    for (const name of [
      "if-match",
      "if-none-match",
      "if-modified-since",
      "if-unmodified-since",
      "if-range",
      "range",
    ])
      headers.delete(name);
    const full = await env.ASSETS.fetch(new Request(request, { headers }));
    if (!isHtml(full)) {
      await full.body?.cancel();
      return response;
    }
    await response.body?.cancel();
    response = full;
  }
  if (!isHtml(response) || (response.status >= 300 && response.status < 400)) return response;

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const headers = new Headers(response.headers);
  const policy = headers.get("Content-Security-Policy") ?? fallbackPolicy;
  headers.set(
    "Content-Security-Policy",
    policy.replace(/(^|;)\s*script-src\s+([^;]*)/, `$1 script-src $2 'nonce-${nonce}'`),
  );
  // Cloudflare reads the header nonce and adds it only to its own injected scripts.
  // Application scripts retain their build-time hashes; HTML must never reuse a nonce.
  headers.set("Cache-Control", "no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  for (const name of ["etag", "last-modified", "accept-ranges", "content-range", "age", "expires"])
    headers.delete(name);
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isHtml(response: Response) {
  return response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() === "text/html";
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return serveAsset(request, env);
    const method = routes.get(url.pathname);
    if (!method) return new Response("Not found", { status: 404 });
    if (request.method !== method)
      return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
    const target = new URL(url.pathname.slice(4) + url.search, env.VECTIS_CONVEX_SITE);
    const headers = new Headers();
    for (const name of [
      "content-type",
      "x-hub-signature-256",
      "x-github-event",
      "x-github-delivery",
      "authorization",
      "origin",
      "cookie",
    ])
      if (request.headers.has(name)) headers.set(name, request.headers.get(name) ?? "");
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  },
} satisfies ExportedHandler<Env>;
