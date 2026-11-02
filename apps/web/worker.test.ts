import { afterEach, expect, test, vi } from "vitest";
import worker from "./worker.js";

const policy =
  "default-src 'self'; script-src 'self' 'sha256-app' https://clerk.example https://challenges.cloudflare.com; object-src 'none'";
const html =
  '<script>trusted app</script><script>untrusted</script><button onclick="evil()">Test</button>';
const asset = (body: string | null = html, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy,
      ETag: '"asset"',
      "Last-Modified": "Mon, 02 Nov 2026 12:00:00 GMT",
      "Cache-Control": "public, max-age=3600",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    },
  });
function serve(request: Request, fetch = vi.fn(async (_request: Request) => asset())) {
  return worker.fetch(request, {
    ASSETS: { fetch },
    VECTIS_CONVEX_SITE: "https://backend.example",
  });
}
afterEach(() => vi.unstubAllGlobals());

test("fresh 256-bit nonces preserve hashes, hosts and body without trusting arbitrary scripts", async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => serve(new Request("https://site.example/connect"))),
  );
  const nonces = new Set<string>();
  for (const response of responses) {
    const csp = response.headers.get("content-security-policy")!;
    expect(csp.replace(/ 'nonce-[^']+'/, "")).toBe(policy);
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    nonces.add(nonce!);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic/);
    expect(await response.text()).toBe(html);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("last-modified")).toBe(false);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(nonces.size).toBe(8);
});

test.each([304, 206, 412, 416])(
  "conditional/range HTML %s becomes a complete fresh response",
  async (status) => {
    const fetch = vi
      .fn(async (_request: Request) => asset(null, status))
      .mockResolvedValueOnce(asset(null, status))
      .mockResolvedValueOnce(asset());
    const response = await serve(
      new Request("https://site.example/connect", {
        headers: {
          "If-None-Match": '"asset"',
          Range: "bytes=0-8",
          "If-Modified-Since": "yesterday",
        },
      }),
      fetch,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    const retried = fetch.mock.calls[1]?.[0];
    expect(retried?.headers.has("if-none-match")).toBe(false);
    expect(retried?.headers.has("range")).toBe(false);
    expect(retried?.headers.has("if-modified-since")).toBe(false);
  },
);

test("HEAD, HTML 404, aliases and Accept do not bypass nonce handling", async () => {
  for (const path of ["/missing.js", "/connect.html", "/docs/missing"]) {
    const response = await serve(
      new Request(`https://site.example${path}`, {
        method: "HEAD",
        headers: { Accept: "application/json" },
      }),
      vi.fn(async () => asset(null, 404)),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toContain("'nonce-");
  }
});

test("redirects, non-HTML assets and unsupported methods pass through unchanged", async () => {
  for (const response of [
    Response.redirect("https://site.example/connect", 307),
    new Response("css", {
      headers: {
        "Content-Type": "text/css",
        ETag: '"css"',
        "Cache-Control": "public, max-age=3600",
      },
    }),
    new Response(null, { status: 405 }),
  ]) {
    const fetch = vi.fn(async () => response);
    expect(await serve(new Request("https://site.example/file"), fetch)).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  const response = asset();
  expect(
    await serve(
      new Request("https://site.example/connect", { method: "POST" }),
      vi.fn(async () => response),
    ),
  ).toBe(response);
});

test("non-HTML conditional and range responses retain status, headers and body", async () => {
  for (const status of [304, 206]) {
    const original = new Response(status === 304 ? null : "partial", {
      status,
      headers: { ETag: '"js"' },
    });
    const fetch = vi
      .fn(async () => new Response("js", { headers: { "Content-Type": "text/javascript" } }))
      .mockResolvedValueOnce(original);
    expect(await serve(new Request("https://site.example/app.js"), fetch)).toBe(original);
  }
});

test("HTML without a staged policy has a restrictive fallback", async () => {
  const response = await serve(
    new Request("https://site.example/missing"),
    vi.fn(
      async () => new Response(html, { status: 404, headers: { "Content-Type": "text/html" } }),
    ),
  );
  expect(response.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-/);
});

test("API allowlist and proxy preserve routing, body and confidential header boundary", async () => {
  const assets = vi.fn(async () => asset());
  const upstream = vi.fn(
    async (_target: URL, _options: RequestInit) =>
      new Response("upstream", { status: 202, headers: { "X-Upstream": "kept" } }),
  );
  vi.stubGlobal("fetch", upstream);
  expect((await serve(new Request("https://site.example/api/unknown"), assets)).status).toBe(404);
  expect((await serve(new Request("https://site.example/api/github/webhook"), assets)).status).toBe(
    405,
  );
  const response = await serve(
    new Request("https://site.example/api/github/webhook?x=1", {
      method: "POST",
      body: "payload",
      headers: { "X-Github-Event": "push", "X-Private": "secret", "CF-Connecting-IP": "127.0.0.1" },
    }),
    assets,
  );
  expect(response.status).toBe(202);
  expect(response.headers.has("content-security-policy")).toBe(false);
  expect(response.headers.get("x-upstream")).toBe("kept");
  expect(upstream.mock.calls[0]?.[0]).toEqual(
    new URL("https://backend.example/github/webhook?x=1"),
  );
  const options = upstream.mock.calls[0]?.[1];
  expect(new Headers(options?.headers).get("x-github-event")).toBe("push");
  expect(new Headers(options?.headers).has("x-private")).toBe(false);
  expect(new Headers(options?.headers).has("cf-connecting-ip")).toBe(false);
  expect(assets).not.toHaveBeenCalled();
});
