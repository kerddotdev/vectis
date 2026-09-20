import { Schema } from "effect";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { httpAction, internalMutation } from "./_generated/server.js";
import { readBody } from "./httpBody.js";
import { purgeOwner } from "./purge.js";

const Payload = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({ id: Schema.optional(Schema.String) }),
});

// Clerk signs webhooks the Svix way: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the secret
// that follows the whsec_ prefix, base64 encoded, and a delivery can carry several signatures.
export async function verifyClerkWebhook(
  secret: string,
  headers: Pick<Headers, "get">,
  body: Uint8Array<ArrayBuffer>,
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
  const signed = new Uint8Array([
    ...new TextEncoder().encode(`${id}.${timestamp}.`),
    ...body,
  ]) as Uint8Array<ArrayBuffer>;
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
    const provided = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (await crypto.subtle.verify("HMAC", key, provided, signed)) return true;
  }
  return false;
}

export const userDeleted = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const issuer = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (!issuer) throw new Error("CLERK_JWT_ISSUER_DOMAIN is not configured.");
    await purgeOwner(ctx, `${issuer}|${args.userId}`);
  },
});

export const receive = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return new Response("Clerk webhooks are not configured", { status: 503 });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readBody(request, 256 * 1024);
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  if (!(await verifyClerkWebhook(secret, request.headers, body)))
    return new Response("Invalid signature", { status: 401 });
  let payload: typeof Payload.Type;
  try {
    payload = Schema.decodeUnknownSync(Payload)(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (payload.type === "user.deleted" && payload.data.id)
    await ctx.runMutation(internal.clerkWebhook.userDeleted, { userId: payload.data.id });
  return Response.json({ accepted: true }, { status: 202 });
});
