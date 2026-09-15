"use node";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { v } from "convex/values";
import { action, internalAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { human } from "./auth.js";

function signingKey() {
  const pem = process.env.VECTIS_MACHINE_PRIVATE_KEY;
  if (!pem) throw new Error("Machine authentication is not configured.");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa")
    throw new Error("Machine signing requires an RSA key.");
  const publicKey = createPublicKey(privateKey);
  const kid = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 24);
  return { privateKey, publicKey, kid };
}
export const issueCredential = action({
  args: { machineId: v.id("machines") },
  handler: async (ctx, args): Promise<{ secret: string }> => {
    const owner = await human(ctx);
    const secret = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(secret).digest("hex");
    await ctx.runMutation(internal.credentials.replace, {
      owner,
      machineId: args.machineId,
      digest,
    });
    return { secret };
  },
});
export const jwks = internalAction({
  args: {},
  handler: async () => {
    const { publicKey, kid } = signingKey();
    return { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] };
  },
});
export const signToken = internalAction({
  args: { machineId: v.id("machines"), credentialVersion: v.number() },
  handler: async (_ctx, args) => {
    const issuer = process.env.VECTIS_MACHINE_ISSUER;
    if (!issuer) throw new Error("Machine issuer is not configured.");
    const { privateKey, kid } = signingKey();
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", typ: "JWT", kid });
    const payload = encode({
      iss: issuer,
      aud: "vectis-machine",
      sub: args.machineId,
      credentialVersion: args.credentialVersion,
      iat: now - 5,
      exp: now + 300,
    });
    const data = `${header}.${payload}`;
    return {
      token: `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`,
      expiresAt: (now + 300) * 1000,
    };
  },
});
