import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../env.js";
import { unauthorizedHuman } from "../errors.js";

const keySets = new Map<string, JWTVerifyGetKey>();

// Verifies a Clerk session token. The owner string keeps Convex's tokenIdentifier shape,
// `${issuer}|${subject}`, which is what the Clerk webhook purges.
export async function authenticateHuman(env: Env, request: Request) {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorizedHuman();
  const issuer = env.CLERK_ISSUER;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), keys, {
      issuer,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    // Clerk sets azp to the origin the session belongs to; only our web origin may act.
    if (!payload.sub || (payload.azp !== undefined && payload.azp !== env.VECTIS_WEB_URL))
      throw unauthorizedHuman();
    return `${issuer}|${payload.sub}`;
  } catch {
    throw unauthorizedHuman();
  }
}
