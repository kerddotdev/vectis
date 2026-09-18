import { Schema } from "effect";
import type { Store } from "./store.js";

const ReservedEnvironment = Schema.Struct({ configuration: Schema.Struct({ id: Schema.String }) });
export function hasReservedEnvironment(store: Store, id: string) {
  return ["preparation", "macInstallation", "windowsInstallation"].some((kind) =>
    store
      .list(kind)
      .some(
        (value) => Schema.decodeUnknownSync(ReservedEnvironment)(value).configuration.id === id,
      ),
  );
}
