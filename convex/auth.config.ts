import type { AuthConfig } from "convex/server";

const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (!clerkIssuer) throw new Error("CLERK_JWT_ISSUER_DOMAIN is required.");
const machineIssuer = process.env.VECTIS_MACHINE_ISSUER;
if (!machineIssuer) throw new Error("VECTIS_MACHINE_ISSUER is required.");
export default {
  providers: [
    { domain: clerkIssuer, applicationID: "convex" },
    {
      type: "customJwt",
      issuer: machineIssuer,
      jwks: `${machineIssuer}/.well-known/jwks.json`,
      algorithm: "RS256",
      applicationID: "vectis-machine",
    },
  ],
} satisfies AuthConfig;
