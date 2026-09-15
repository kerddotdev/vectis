import { Schema } from "effect";
import { Identifier } from "./index.js";
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const PairingDescriptor = Schema.Struct({
  deploymentUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.convex\.cloud$/)),
  requestDigest: Digest,
  credentialDigest: Digest,
  localId: Identifier,
  name: Schema.NonEmptyString,
  expiresAt: Schema.Number,
});
export type PairingDescriptor = typeof PairingDescriptor.Type;
