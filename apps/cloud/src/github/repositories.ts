import type { Env } from "../env.js";
import type { Machine } from "../db.js";
import type { AccountOverview } from "../../../../packages/protocol/src/cloud.js";
import type { MachineRepositories } from "../../../../packages/protocol/src/repositories.js";
import { notImplemented, type HumanHandler, type MachineHandler } from "../context.js";

export const enableRepository: HumanHandler<"/repositories/enable"> = async () => notImplemented();
export const disableRepository: HumanHandler<"/repositories/disable"> = async () =>
  notImplemented();

export const connectRepository: MachineHandler<"/machine/repositories/connect"> = async () =>
  notImplemented();
export const disconnectRepository: MachineHandler<"/machine/repositories/disconnect"> = async () =>
  notImplemented();
export const repositoryReadiness: MachineHandler<"/machine/repositories/readiness"> = async () =>
  notImplemented();
export const setAutomatic: MachineHandler<"/machine/repositories/set-automatic"> = async () =>
  notImplemented();
export const setInfraRerun: MachineHandler<"/machine/repositories/set-infra-rerun"> = async () =>
  notImplemented();
export const setCapacityMode: MachineHandler<
  "/machine/repositories/set-capacity-mode"
> = async () => notImplemented();
export const setCacheVolume: MachineHandler<"/machine/repositories/set-cache-volume"> = async () =>
  notImplemented();
export const setAccess: MachineHandler<"/machine/repositories/set-access"> = async () =>
  notImplemented();

// The machine's enabled bindings as the protocol MachineRepositories, oldest first.
export async function machineRepositories(
  _env: Env,
  _machine: Machine,
): Promise<MachineRepositories> {
  return notImplemented();
}

export async function accountBindings(
  _env: Env,
  _owner: string,
): Promise<AccountOverview["bindings"]> {
  return notImplemented();
}

// Deletes a binding with its leases, demands and previews, and marks its scale sets for cleanup.
export async function purgeBinding(_env: Env, _bindingId: string): Promise<void> {
  notImplemented();
}
