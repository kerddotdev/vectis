import type { Env } from "./env.js";
import type { AccountOverview } from "../../../packages/protocol/src/cloud.js";
import { notImplemented, type HumanHandler } from "./context.js";

export type AccountMachine = AccountOverview["machines"][number];

// The owner's machines with live presence from their hubs, newest first is not required.
export async function listMachines(_env: Env, _owner: string): Promise<AccountMachine[]> {
  return notImplemented();
}

// Deletes a machine and everything that belongs to it, closes its socket with
// socketCloseCodes.removed, and leaves its scale sets for cleanup.
export async function purgeMachine(_env: Env, _machineId: string): Promise<void> {
  notImplemented();
}

export const removeMachine: HumanHandler<"/machines/remove"> = async () => notImplemented();
