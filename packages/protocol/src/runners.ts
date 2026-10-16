import { Schema } from "effect";
import { RunnerAccess } from "./repository-access.js";
import { GuestOS, Identifier } from "./index.js";

export const RunnerGrant = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("ready"),
    id: Schema.NonEmptyString,
    runnerId: Schema.Int,
    encodedConfig: Schema.NonEmptyString,
    cacheWrite: Schema.Boolean,
    environmentId: Identifier,
    os: GuestOS,
    access: Schema.optional(RunnerAccess),
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
  prepareRunner(
    bindingId: string,
    key: string,
    signal: AbortSignal,
    request?: { jobId?: number; automatic?: boolean },
  ): Promise<RunnerGrant>;
  releaseRunner(id: string, signal: AbortSignal): Promise<void>;
  runnerStatus(leaseId: string, signal: AbortSignal): Promise<RunnerStatus>;
}

export const PhaseName = Schema.Literals([
  "queued_locally",
  "vm_start",
  "warm_takeover",
  "vm_start_and_guest_ready",
  "guest_ready",
  "runner_install",
  "runner_preinstalled",
  "job_check",
  "registration",
  "waiting_for_job",
  "job",
  "cleanup",
]);
export type PhaseName = typeof PhaseName.Type;
export const RunnerPhase = Schema.Struct({
  name: PhaseName,
  startedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
});
export type RunnerPhase = typeof RunnerPhase.Type;

export const RunnerProgress = Schema.Struct({
  bindingId: Identifier,
  environmentId: Identifier,
  leaseKey: Schema.NonEmptyString,
  instanceId: Schema.optional(Identifier),
  leaseId: Schema.optional(Identifier),
  runnerId: Schema.optional(Schema.Int),
  phases: Schema.optional(Schema.Array(RunnerPhase).check(Schema.isMaxLength(16))),
  diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  cause: Schema.optional(
    Schema.Struct({
      code: Schema.Literal("runner_assignment_rejected"),
      message: Schema.String,
    }),
  ),
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
