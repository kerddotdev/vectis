import { Schema } from "effect";

// The cloud is one origin. Production is HTTPS; development builds may use a loopback HTTP origin
// for `wrangler dev`. Clients decide which of the two their flavor accepts.
export const CloudUrl = Schema.String.check(
  Schema.isPattern(
    /^(https:\/\/[a-z0-9.-]+(:[0-9]+)?|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?)$/,
  ),
);
