import { Schema } from "effect";
import { Identifier } from "./identifier.js";

// How a binding gets runner capacity. "demand" is the per-job webhook scheduler; "scale_set" is a
// GitHub runner scale set that this machine long-polls for assigned job levels.
export const CapacityMode = Schema.Literals(["demand", "scale_set"]);
export type CapacityMode = typeof CapacityMode.Type;

export const ScaleSetStatistics = Schema.Struct({
  totalAssignedJobs: Schema.Int,
  totalAvailableJobs: Schema.optional(Schema.Int),
  totalAcquiredJobs: Schema.optional(Schema.Int),
  totalRunningJobs: Schema.optional(Schema.Int),
  totalRegisteredRunners: Schema.optional(Schema.Int),
  totalBusyRunners: Schema.optional(Schema.Int),
  totalIdleRunners: Schema.optional(Schema.Int),
});
export type ScaleSetStatistics = typeof ScaleSetStatistics.Type;

// Issued by the cloud to the one machine that owns the binding. The queue token only reads and
// acknowledges this scale set's message queue and acquires its jobs; it never appears in snapshots,
// operation results, logs or guests.
export const ScaleSetGrant = Schema.Struct({
  bindingId: Identifier,
  scaleSetId: Schema.Int,
  scaleSetName: Schema.NonEmptyString,
  generation: Schema.Int,
  sessionId: Schema.NonEmptyString,
  messageQueueUrl: Schema.NonEmptyString,
  messageQueueAccessToken: Schema.NonEmptyString,
  queueTokenExpiresAt: Schema.optional(Schema.Number),
  statistics: Schema.optional(ScaleSetStatistics),
});
export type ScaleSetGrant = typeof ScaleSetGrant.Type;

// Visible state of a scale set listener, safe for snapshots and every surface.
export const ScaleSetState = Schema.Struct({
  bindingId: Identifier,
  state: Schema.Literals(["connecting", "listening", "action_required", "stopped"]),
  scaleSetName: Schema.optional(Schema.String),
  assignedJobs: Schema.optional(Schema.Int),
  reservedRunners: Schema.optional(Schema.Int),
  lastMessageAt: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type ScaleSetState = typeof ScaleSetState.Type;

export interface ScaleSetBroker {
  // Gets or creates this machine's scale set for the binding and opens a session. A newer generation
  // fences every older one; refresh and close with an old generation fail with scale_set_superseded.
  openScaleSet(bindingId: string, signal: AbortSignal): Promise<ScaleSetGrant>;
  refreshScaleSet(
    bindingId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<ScaleSetGrant>;
  closeScaleSet(bindingId: string, generation: number, signal: AbortSignal): Promise<void>;
}
