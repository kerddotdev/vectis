import type { Env } from "../env.js";
import type { Binding, Machine } from "../db.js";
import type { JobObservations } from "../../../../packages/protocol/src/jobs.js";
import { notImplemented, type MachineHandler } from "../context.js";

export const listJobs: MachineHandler<"/machine/jobs/list"> = async () => notImplemented();
export const scanJobs: MachineHandler<"/machine/jobs/scan"> = async () => notImplemented();
export const refreshJob: MachineHandler<"/machine/jobs/refresh"> = async () => notImplemented();
export const jobLogs: MachineHandler<"/machine/jobs/logs"> = async () => notImplemented();

// The protocol JobMarker of each binding: its repository's newest job update time, or null.
export async function jobMarkers(
  _env: Env,
  _bindings: readonly Binding[],
): Promise<Record<string, number | null>> {
  return notImplemented();
}

// The current job of each of the machine's leases that has one (was jobs.forLeases).
export async function leaseObservations(
  _env: Env,
  _machine: Machine,
  _leaseIds: readonly string[],
): Promise<JobObservations> {
  return notImplemented();
}
