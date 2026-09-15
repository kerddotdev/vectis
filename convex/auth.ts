import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";

export async function human(ctx: Pick<QueryCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (
    !identity ||
    !process.env.CLERK_JWT_ISSUER_DOMAIN ||
    identity.issuer !== process.env.CLERK_JWT_ISSUER_DOMAIN
  )
    throw new ConvexError({ code: "unauthorized", nextStep: "Sign in to Vectis." });
  return identity.tokenIdentifier;
}
export async function machine(ctx: Pick<QueryCtx, "auth" | "db">) {
  const identity = await ctx.auth.getUserIdentity();
  if (
    !identity ||
    !process.env.VECTIS_MACHINE_ISSUER ||
    identity.issuer !== process.env.VECTIS_MACHINE_ISSUER
  )
    throw new ConvexError({
      code: "machine_unauthorized",
      nextStep: "Reconnect this machine to Vectis.",
    });
  const id = ctx.db.normalizeId("machines", identity.subject);
  const record = id ? await ctx.db.get("machines", id) : null;
  if (!record || record.revoked)
    throw new ConvexError({
      code: "machine_revoked",
      nextStep: "Enroll the machine again with its owner.",
    });
  return record;
}
