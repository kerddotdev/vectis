import { Schema } from "effect";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { human } from "./auth.js";
import { readBody, smallJson } from "./httpBody.js";
import { webUrl } from "./site.js";

const callbackUrl = () => `${webUrl()}/api/github/oauth/callback`;
const connectUrl = () => `${webUrl()}/connect?github=1`;
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const hash = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const digest = async (value: string) =>
  Array.from(await hash(value), (b) => b.toString(16).padStart(2, "0")).join("");
const browserCookie = "__Host-vectis-github-browser";
const completionCookie = "__Host-vectis-github-completion";
const cookie = (name: string, value: string) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`;
function readCookie(request: Request, name: string) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  const value = values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export const begin = httpAction(async (ctx, request) => {
  if (request.headers.get("Origin") !== webUrl())
    return new Response("Origin denied", { status: 403 });
  try {
    const owner = await human(ctx);
    const browser = base64(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
    const { clientId } = await ctx.runMutation(internal.githubIdentity.create, {
      owner,
      digest: await digest(state),
      verifier,
      browserDigest: await digest(browser),
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl(),
      state,
      code_challenge: base64(await hash(verifier)),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return Response.json(
      { url: `https://github.com/login/oauth/authorize?${params}` },
      {
        headers: { ...privateHeaders, "Set-Cookie": cookie(browserCookie, browser) },
      },
    );
  } catch {
    return Response.json(
      { code: "github_link_unavailable" },
      { status: 400, headers: privateHeaders },
    );
  }
});
export const confirm = httpAction(async (ctx, request) => {
  if (request.headers.get("Origin") !== webUrl())
    return new Response("Origin denied", { status: 403 });
  const browser = readCookie(request, browserCookie);
  const completion = readCookie(request, completionCookie);
  if (!browser || !completion)
    return new Response("Browser verification required", { status: 403, headers: privateHeaders });
  try {
    const owner = await human(ctx);
    const body = await smallJson(request);
    if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
      return new Response("Invalid request", { status: 400, headers: privateHeaders });
    await ctx.runMutation(internal.githubIdentity.confirm, {
      owner,
      id: body.id,
      browserDigest: await digest(browser),
      completionDigest: await digest(completion),
    });
    const headers = new Headers(privateHeaders);
    for (const name of [browserCookie, completionCookie])
      headers.append("Set-Cookie", `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return Response.json({ linked: true }, { headers });
  } catch {
    return Response.json(
      { code: "github_link_unavailable" },
      { status: 400, headers: privateHeaders },
    );
  }
});
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.Literal("bearer"),
});
const User = Schema.Struct({ id: Schema.Int, login: Schema.NonEmptyString });
const Installations = Schema.Struct({
  total_count: Schema.Int,
  installations: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      app_id: Schema.Int,
      account: Schema.Struct({ id: Schema.Int, login: Schema.NonEmptyString }),
      suspended_at: Schema.NullOr(Schema.String),
    }),
  ),
});
async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("GitHub request failed.");
  }
  return JSON.parse(new TextDecoder().decode(await readBody(response, 512 * 1024)));
}
export const callback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const headers = privateHeaders;
  if (!state)
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: connectUrl() },
    });
  if (!/^[A-Za-z0-9_-]{43}$/.test(state))
    return new Response("Start GitHub linking from Vectis before authorizing this App.", {
      status: 400,
      headers,
    });
  const browser = readCookie(request, browserCookie);
  if (!browser)
    return new Response("Start GitHub linking in this browser from Vectis.", {
      status: 403,
      headers,
    });
  const claim = await ctx.runMutation(internal.githubIdentity.claim, {
    digest: await digest(state),
    browserDigest: await digest(browser),
  });
  if (!claim)
    return new Response("This request expired or was already used. Start again from Vectis.", {
      status: 403,
      headers,
    });
  const deadline = AbortSignal.timeout(40000);
  try {
    if (!code || code.length > 512 || params.has("error")) throw new Error("Authorization denied.");
    const token = Schema.decodeUnknownSync(Token)(
      await json(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: claim.clientId,
            client_secret: claim.clientSecret,
            code,
            redirect_uri: callbackUrl(),
            code_verifier: claim.verifier,
          }).toString(),
        },
        deadline,
      ),
    );
    const authorization = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    };
    const user = Schema.decodeUnknownSync(User)(
      await json("https://api.github.com/user", { headers: authorization }, deadline),
    );
    const installations: { id: number; accountId: number; login: string }[] = [];
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const result = Schema.decodeUnknownSync(Installations)(
        await json(
          `https://api.github.com/user/installations?per_page=100&page=${page}`,
          {
            headers: authorization,
          },
          deadline,
        ),
      );
      for (const item of result.installations)
        if (item.app_id === claim.appId && item.suspended_at === null)
          installations.push({
            id: item.id,
            accountId: item.account.id,
            login: item.account.login,
          });
      if (page * 100 >= result.total_count) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("Too many installations.");
    const completion = base64(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.runMutation(internal.githubIdentity.finish, {
      id: claim.id,
      user: { ...user, installations },
      completionDigest: await digest(completion),
    });
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        Location: connectUrl(),
        "Set-Cookie": cookie(completionCookie, completion),
      },
    });
  } catch {
    await ctx.runMutation(internal.githubIdentity.finish, { id: claim.id });
    return new Response(
      "GitHub verification did not finish. Return to Vectis and start a new request.",
      { status: 502, headers },
    );
  }
});
