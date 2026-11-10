import type { Env } from "./env.js";
import type { LocalQuery } from "../../../packages/protocol/src/controller.js";
import type { ControllerResponses } from "../../../packages/protocol/src/cloud.js";
import { notImplemented, type MachineHandler } from "./context.js";

export const respond: MachineHandler<"/machine/inspections/respond"> = async () => notImplemented();

export async function submitInspection(
  _env: Env,
  _owner: string,
  _machineId: string,
  _key: string,
  _query: LocalQuery,
): Promise<ControllerResponses["query.submit"]["Type"]> {
  return notImplemented();
}

export async function getInspection(
  _env: Env,
  _owner: string,
  _id: string,
): Promise<ControllerResponses["query.get"]["Type"]> {
  return notImplemented();
}
