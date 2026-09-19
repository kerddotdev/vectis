import type { ExportedHandler, Fetcher } from "@cloudflare/workers-types";

// Deploy scripts pass VECTIS_CONVEX_SITE with --var, so each deployment keeps its own backend.
interface Env {
  ASSETS: Fetcher;
  VECTIS_CONVEX_SITE: string;
}

const routes = new Map([
  ["/api/github/app/setup", "GET"],
  ["/api/github/manifest/callback", "GET"],
  ["/api/github/oauth/callback", "GET"],
  ["/api/github/webhook", "POST"],
]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
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
