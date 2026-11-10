import type { Env } from "./env.js";
import type { HubPresence } from "./hub.js";

// The one place other modules reach a machine's hub. Hubs are named by machine id.
export const hubFor = (env: Env, machineId: string) => env.HUB.getByName(machineId);

// Tells the machine to sync. Best effort: an offline machine syncs when it reconnects.
export async function notifyMachine(env: Env, machineId: string) {
  try {
    await hubFor(env, machineId).notify();
  } catch (error) {
    console.error("notify failed", machineId, error);
  }
}

// Asks the machine's hub to evaluate runner demand. Hubs serialize evaluations per machine.
export async function requestDemand(env: Env, machineId: string) {
  try {
    await hubFor(env, machineId).demand();
  } catch (error) {
    console.error("demand failed", machineId, error);
  }
}

export function machinePresence(env: Env, machineId: string): Promise<HubPresence> {
  return hubFor(env, machineId).presence();
}

// Closes the machine's sockets, for example with socketCloseCodes.removed after deletion.
export function disconnectMachine(env: Env, machineId: string, code: number) {
  return hubFor(env, machineId).disconnect(code);
}
