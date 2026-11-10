import type { Env } from "./env.js";
import type { ControllerResponses } from "../../../packages/protocol/src/cloud.js";
import { notImplemented, type MachineHandler, type Sweep } from "./context.js";

export const acknowledge: MachineHandler<"/machine/operations/acknowledge"> = async () =>
  notImplemented();

// Queues a command for a machine the owner owns. Idempotent per (owner, key); returns the id.
export async function submitOperation(
  _env: Env,
  _owner: string,
  _input: { machineId: string; key: string; commandJson: string },
): Promise<string> {
  return notImplemented();
}

export async function cancelOperation(_env: Env, _owner: string, _id: string): Promise<string> {
  return notImplemented();
}

export async function getOperation(
  _env: Env,
  _owner: string,
  _id: string,
): Promise<ControllerResponses["operation.get"]["Type"]> {
  return notImplemented();
}

// Cancels accepted operations nobody claimed in time (claim_timeout / machine_offline).
export const sweepOperations: Sweep = async () => notImplemented();
