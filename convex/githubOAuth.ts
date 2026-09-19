import { Schema } from "effect";
import { action, httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { human } from "./auth.js";
import { readBody } from "./httpBody.js";
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
export const begin = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const owner = await human(ctx);
    const state = base64(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
    const { clientId } = await ctx.runMutation(internal.githubIdentity.create, {
      owner,
      digest: await digest(state),
      verifier,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl(),
      state,
      code_challenge: base64(await hash(verifier)),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return { url: `https://github.com/login/oauth/authorize?${params}` };
  },
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
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
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
  const claim = await ctx.runMutation(internal.githubIdentity.claim, {
    digest: await digest(state),
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
    await ctx.runMutation(internal.githubIdentity.finish, {
      id: claim.id,
      user: { ...user, installations },
    });
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: connectUrl() },
    });
  } catch {
    await ctx.runMutation(internal.githubIdentity.finish, { id: claim.id });
    return new Response(
      "GitHub verification did not finish. Return to Vectis and start a new request.",
      { status: 502, headers },
    );
  }
});
