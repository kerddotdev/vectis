import { Schema } from "effect";
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
});
export type Diagnostics = typeof Diagnostics.Type;
