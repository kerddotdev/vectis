import { Schema } from "effect";
import { GitHubUser, type AccountOverview } from "../../../packages/protocol/src/cloud.js";
import type { HumanContext, HumanHandler, RawHandler } from "./context.js";
import type { Env } from "./env.js";
import { accountRecord, type GitHubAccountRow, type GitHubLinkRow } from "./db.js";
import { listMachines, purgeMachine } from "./machines.js";
import { accountBindings } from "./github/repositories.js";
import { markScaleSetsForCleanup } from "./runners/scale-sets.js";
import { readBody } from "./http.js";
export async function overview({ env, owner }: HumanContext): Promise<AccountOverview> {
  const [machines, bindings, accounts, pending, controllers, app] = await Promise.all([
    listMachines(env, owner),
    accountBindings(env, owner),
    env.DB.prepare("SELECT * FROM githubAccounts WHERE owner = ? LIMIT 100")
      .bind(owner)
      .all<GitHubAccountRow>(),
    env.DB.prepare("SELECT * FROM githubLinks WHERE owner = ? AND expiresAt > ? LIMIT 20")
      .bind(owner, Date.now())
      .all<GitHubLinkRow>(),
    env.DB.prepare(
      "SELECT id, name, createdAt, expiresAt FROM controllers WHERE owner = ? AND revoked = 0 AND expiresAt > ? LIMIT 20",
    )
      .bind(owner, Date.now())
      .all<AccountOverview["controllers"][number]>(),
    env.DB.prepare("SELECT slug FROM githubApps WHERE singleton = 1").first<{ slug: string }>(),
  ]);
  return {
    machines,
    bindings,
    github: {
      accounts: accounts.results.map((row) => {
        const { id, githubId, login, installations, verifiedAt } = accountRecord(row);
        return { id, githubId, login, installations, verifiedAt };
      }),
      pending: pending.results.map((row) => ({
        id: row.id,
        phase: row.phase,
        ...(row.userJson
          ? { user: Schema.decodeUnknownSync(GitHubUser)(JSON.parse(row.userJson)) }
          : {}),
      })),
    },
    controllers: controllers.results,
    installation: app ? { url: `https://github.com/apps/${app.slug}/installations/new` } : null,
  };
}
async function purgeOwner(env: Env, owner: string) {
  for (;;) {
    const machines = await env.DB.prepare("SELECT id FROM machines WHERE owner = ? LIMIT 100")
      .bind(owner)
      .all<{ id: string }>();
    if (!machines.results.length) break;
    for (const machine of machines.results) await purgeMachine(env, machine.id);
  }
  for (;;) {
    const bindings = await env.DB.prepare(
      "SELECT id FROM repositoryBindings WHERE owner = ? LIMIT 100",
    )
      .bind(owner)
      .all<{ id: string }>();
    if (!bindings.results.length) break;
    await markScaleSetsForCleanup(
      env,
      bindings.results.map((b) => b.id),
    );
    await env.DB.batch(
      bindings.results.map((b) =>
        env.DB.prepare("DELETE FROM repositoryBindings WHERE id = ?").bind(b.id),
      ),
    );
  }
  for (const table of [
    "githubAccounts",
    "githubLinks",
    "controllers",
    "pairings",
    "operations",
    "inspections",
  ]) {
    for (;;) {
      const result = await env.DB.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE owner = ? LIMIT 100)`,
      )
        .bind(owner)
        .run();
      if (result.meta.changes < 100) break;
    }
  }
}
export const removeAccount: HumanHandler<"/account/remove"> = async ({ env, owner }) => {
  await purgeOwner(env, owner);
  return null;
};
export async function verifyClerkWebhook(
  secret: string,
  headers: Pick<Headers, "get">,
  body: Uint8Array,
  now = Date.now(),
) {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!secret.startsWith("whsec_") || !id || !timestamp || !signatures) return false;
  if (!/^[0-9]{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new Uint8Array([...new TextEncoder().encode(`${id}.${timestamp}.`), ...body]);
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
    const provided = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (await crypto.subtle.verify("HMAC", key, provided, signed)) return true;
  }
  return false;
}

const Payload = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({ id: Schema.optional(Schema.String) }),
});
export const clerkWebhook: RawHandler = async ({ env }, request) => {
  if (!env.CLERK_WEBHOOK_SECRET)
    return new Response("Clerk webhooks are not configured", { status: 503 });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readBody(request, 256 * 1024);
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  let valid = false;
  try {
    valid = await verifyClerkWebhook(env.CLERK_WEBHOOK_SECRET, request.headers, body);
  } catch {
    /* Invalid secret or signature encoding. */
  }
  if (!valid) return new Response("Invalid signature", { status: 401 });
  let payload: typeof Payload.Type;
  try {
    payload = Schema.decodeUnknownSync(Payload)(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (payload.type === "user.deleted" && payload.data.id)
    await purgeOwner(env, `${env.CLERK_ISSUER}|${payload.data.id}`);
  return Response.json({ accepted: true }, { status: 202 });
};
