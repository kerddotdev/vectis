import type {
  HumanPath,
  HumanRequest,
  HumanResponse,
  MachinePath,
  MachineRequest,
  MachineResponse,
} from "../../../packages/protocol/src/cloud.js";
import type { Env } from "./env.js";
import type { Machine } from "./db.js";
import { CloudError } from "./errors.js";

export interface Context {
  env: Env;
  ctx: ExecutionContext;
}
export interface MachineContext extends Context {
  machine: Machine;
}
export interface HumanContext extends Context {
  owner: string;
}

// Inputs are already decoded against the protocol schema; results are sent as JSON.
export type MachineHandler<P extends MachinePath> = (
  c: MachineContext,
  input: MachineRequest<P>,
) => Promise<MachineResponse<P>>;
export type HumanHandler<P extends HumanPath> = (
  c: HumanContext,
  input: HumanRequest<P>,
) => Promise<HumanResponse<P>>;
// Routes that own their request parsing and response: pairing, controllers, webhooks, OAuth.
export type RawHandler = (c: Context, request: Request) => Promise<Response>;
// Cron work. Each sweep handles one bounded batch of due rows and must be safe to repeat.
export type Sweep = (env: Env, now: number) => Promise<void>;

export const notImplemented = (): never => {
  throw new CloudError("not_implemented", 501);
};
