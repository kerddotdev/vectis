import { Schema } from "effect";
import { ReadinessCheck } from "./readiness.js";
export const Diagnostics = Schema.Struct({
  source: Schema.Literals(["service", "shell"]),
  host: Schema.Struct({
    platform: Schema.String,
    arch: Schema.String,
    cpus: Schema.Int,
    memoryMiB: Schema.Int,
  }),
  supportedHost: Schema.Boolean,
  configured: Schema.Struct({
    appleHelper: Schema.Boolean,
    qemu: Schema.Boolean,
    qemuImg: Schema.Boolean,
    swtpm: Schema.Boolean,
    keychainHelper: Schema.Boolean,
  }),
  home: Schema.String,
  checks: Schema.optional(Schema.Array(ReadinessCheck)),
});
export type Diagnostics = typeof Diagnostics.Type;
