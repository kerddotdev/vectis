import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";

const router = httpRouter();
router.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async (ctx) => {
    try {
      const keys = await ctx.runAction(internal.machineTokens.jwks, {});
      return Response.json(keys, { headers: { "Cache-Control": "public, max-age=300" } });
    } catch {
      return Response.json({ code: "machine_auth_unavailable" }, { status: 503 });
    }
  }),
});
router.route({
  path: "/machine/token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!request.body) return Response.json({ code: "invalid_request" }, { status: 400 });
    const reader = request.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) {
          await reader.cancel();
          return Response.json({ code: "payload_too_large" }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return Response.json({ code: "invalid_request" }, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("machineId" in body) ||
      typeof body.machineId !== "string" ||
      !("secret" in body) ||
      typeof body.secret !== "string" ||
      body.secret.length > 100
    )
      return Response.json({ code: "invalid_request" }, { status: 400 });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.secret));
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const credential = await ctx.runQuery(internal.credentials.verify, {
      machineId: body.machineId,
      digest,
    });
    if (!credential)
      return Response.json(
        { code: "machine_unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    try {
      const token = await ctx.runAction(internal.machineTokens.signToken, credential);
      return Response.json(token, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json(
        { code: "machine_auth_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }),
});
export default router;
