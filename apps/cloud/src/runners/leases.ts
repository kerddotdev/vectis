import { notImplemented, type MachineHandler, type Sweep } from "../context.js";

export const reconcileRunner: MachineHandler<"/machine/runners/reconcile"> = async () =>
  notImplemented();
export const prepareRunner: MachineHandler<"/machine/runners/prepare"> = async () =>
  notImplemented();
export const runnerStatus: MachineHandler<"/machine/runners/status"> = async () => notImplemented();
export const releaseRunner: MachineHandler<"/machine/runners/release"> = async () =>
  notImplemented();

// Drops expired just-in-time runner configs.
export const sweepLeases: Sweep = async () => notImplemented();
