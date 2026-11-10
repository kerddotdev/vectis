import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { notImplemented } from "./context.js";

// Volatile state of one connected machine. Never written to D1.
export interface HubPresence {
  online: boolean;
  lastSeenAt: number | null;
  runnerIdle?: boolean;
  runnerSlots?: number;
}

// One instance per machine (named by machine id). Owns the machine's WebSocket, its last reported
// capacity, and serializes runner-demand evaluation for the machine. index.ts authenticates the
// upgrade and forwards it here with the `X-Vectis-Machine` header set to the machine id.
export class MachineHub extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return notImplemented();
  }
  async notify(): Promise<void> {
    notImplemented();
  }
  async demand(): Promise<void> {
    notImplemented();
  }
  async presence(): Promise<HubPresence> {
    return notImplemented();
  }
  async disconnect(_code: number): Promise<void> {
    notImplemented();
  }
}
