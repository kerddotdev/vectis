import { Schema } from "effect";
import { CloudUrl } from "./cloud-url.js";
import { Identifier } from "./index.js";
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const PairingDescriptor = Schema.Struct({
  deploymentUrl: CloudUrl,
  requestDigest: Digest,
  credentialDigest: Digest,
  localId: Identifier,
  name: Schema.NonEmptyString,
  expiresAt: Schema.Number,
});
export type PairingDescriptor = typeof PairingDescriptor.Type;
