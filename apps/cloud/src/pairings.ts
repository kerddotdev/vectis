import { notImplemented, type HumanHandler, type RawHandler } from "./context.js";

export const approvePairing: HumanHandler<"/pairings/approve"> = async () => notImplemented();
// POST /machine/pairing: the pairing machine polls with its request secret.
export const machinePairing: RawHandler = async () => notImplemented();
