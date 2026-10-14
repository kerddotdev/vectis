import { Schema } from "effect";
import type { Store } from "./store.js";

const ReservedEnvironment = Schema.Struct({
  configuration: Schema.Struct({ id: Schema.String }),
  phase: Schema.String,
});
// A completed setup hands its identifier to the registered environment, so removing that
// environment frees the identifier for a fresh setup.
const completedPhases = new Set(["prepared", "registered"]);
export function hasReservedEnvironment(store: Store, id: string) {
  return ["preparation", "macInstallation", "windowsInstallation"].some((kind) =>
    store.list(kind).some((value) => {
      const setup = Schema.decodeUnknownSync(ReservedEnvironment)(value);
      return setup.configuration.id === id && !completedPhases.has(setup.phase);
    }),
  );
}
