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
export const RunnerStatus = Schema.Union([
  Schema.Struct({ busy: Schema.Boolean, status: Schema.Literals(["online", "offline"]) }),
  Schema.Struct({ missing: Schema.Literal(true) }),
]);
export type RunnerStatus = typeof RunnerStatus.Type;

export interface RunnerBroker {
  reconcileRunner(
    request: { bindingId: string; environmentId: string; key: string },
    signal: AbortSignal,
  ): Promise<RunnerLease>;
  prepareRunner(bindingId: string, key: string, signal: AbortSignal): Promise<RunnerGrant>;
  releaseRunner(id: string, signal: AbortSignal): Promise<void>;
  runnerStatus(leaseId: string, signal: AbortSignal): Promise<RunnerStatus>;
}

export const RunnerProgress = Schema.Struct({
  bindingId: Identifier,
  environmentId: Identifier,
  leaseKey: Schema.NonEmptyString,
  instanceId: Schema.optional(Identifier),
  leaseId: Schema.optional(Identifier),
  runnerId: Schema.optional(Schema.Int),
  diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  stage: Schema.Literals([
    "starting",
    "preparing_guest",
    "registering",
    "listening",
    "cleaning",
    "finished",
  ]),
});
export type RunnerProgress = typeof RunnerProgress.Type;
export const RunnerLease = Schema.Struct({
  id: Identifier,
  bindingId: Identifier,
  environmentId: Identifier,
  phase: Schema.Literals(["preparing", "ready", "action_required", "released"]),
});
export type RunnerLease = typeof RunnerLease.Type;
