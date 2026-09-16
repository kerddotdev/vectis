import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { smallJson } from "./httpBody.js";
import { ControllerRequest } from "../packages/protocol/src/controller.js";

const digest = async (secret: string) => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
export const pairing = httpAction(async (ctx, request) => {
  try {
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
      }),
      { onExcessProperty: "error" },
    )(await smallJson(request));
    return json(
      (await ctx.runQuery(internal.controllers.resolve, {
        requestDigest: await digest(body.secret),
      })) ?? { state: "pending" },
    );
  } catch {
    return json({ code: "invalid_request" }, 400);
  }
});
export const execute = httpAction(async (ctx, request) => {
  const authorization = /^Bearer ([a-z0-9]+)\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("Authorization") ?? "",
  );
  const controllerId = authorization?.[1];
  const secret = authorization?.[2];
  if (!controllerId || !secret) return json({ code: "controller_unauthorized" }, 401);
  let command: ControllerRequest;
  try {
    command = Schema.decodeUnknownSync(ControllerRequest, { onExcessProperty: "error" })(
      await smallJson(request, 65536),
    );
  } catch {
    return json({ code: "invalid_request" }, 400);
  }
  try {
    return json(
      await ctx.runMutation(internal.controllers.execute, {
        controllerId,
        digest: await digest(secret),
        requestJson: JSON.stringify(command),
      }),
    );
  } catch (error) {
    if (
      error instanceof ConvexError &&
      Schema.is(Schema.Struct({ code: Schema.String }))(error.data)
    )
      return json(
        { code: error.data.code },
        error.data.code === "controller_unauthorized" ? 401 : 409,
      );
    return json({ code: "cloud_unavailable" }, 503);
  }
});
