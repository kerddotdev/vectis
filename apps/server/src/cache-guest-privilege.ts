import { Schema } from "effect";
import type { Environment } from "../../../packages/protocol/src/index.js";
import type { Store } from "./store.js";

const Probe = Schema.Struct({ image: Schema.String, allowed: Schema.Boolean });

function imageIdentity(environment: Environment) {
  return JSON.stringify([
    environment.os,
    environment.basePath,
    environment.image ?? null,
    environment.sshUser ?? null,
    environment.sshKeyPath ?? null,
  ]);
}

export function cacheGuestPrivilege(store: Store, environment: Environment) {
  const probe = store.get("cacheGuestPrivilege", environment.id);
  return Schema.is(Probe)(probe) && probe.image === imageIdentity(environment)
    ? probe.allowed
    : undefined;
}

export function recordCacheGuestPrivilege(
  store: Store,
  environment: Environment,
  allowed: boolean,
) {
  store.put("cacheGuestPrivilege", environment.id, { image: imageIdentity(environment), allowed });
}
