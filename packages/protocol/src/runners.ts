import { Schema } from "effect";
import { GuestOS, Identifier } from "./index.js";

export const RunnerGrant = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("ready"),
    id: Schema.NonEmptyString,
    runnerId: Schema.Int,
    encodedConfig: Schema.NonEmptyString,
    environmentId: Identifier,
    os: GuestOS,
  }),
  Schema.Struct({
    state: Schema.Literals(["pending", "action_required", "released"]),
    id: Schema.NonEmptyString,
  }),
]);
export type RunnerGrant = typeof RunnerGrant.Type;
export interface RunnerBroker {
  prepareRunner(bindingId: string, key: string, signal: AbortSignal): Promise<RunnerGrant>;
  releaseRunner(id: string, signal: AbortSignal): Promise<void>;
}
