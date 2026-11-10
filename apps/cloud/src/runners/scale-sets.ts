import type { Env } from "../env.js";
import { notImplemented, type MachineHandler, type Sweep } from "../context.js";

export const openScaleSet: MachineHandler<"/machine/scale-sets/open"> = async () =>
  notImplemented();
export const refreshScaleSet: MachineHandler<"/machine/scale-sets/refresh"> = async () =>
  notImplemented();
export const closeScaleSet: MachineHandler<"/machine/scale-sets/close"> = async () =>
  notImplemented();

// Marks the scale sets of these bindings for remote deletion. Call before deleting the bindings
// (or their machine or account); sweepScaleSets removes the remote sets and then the rows.
export async function markScaleSetsForCleanup(_env: Env, _bindingIds: string[]): Promise<void> {
  notImplemented();
}

export const sweepScaleSets: Sweep = async () => notImplemented();
