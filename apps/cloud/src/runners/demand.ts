import type { Env } from "../env.js";
import { notImplemented, type Sweep } from "../context.js";

// Called after a job of this repository changed: asks the hub of every machine with an automatic
// demand binding for the repository to evaluate demand.
export async function demandForRepository(
  _env: Env,
  _installationId: number,
  _repositoryId: number,
): Promise<void> {
  notImplemented();
}

// Re-evaluates machines that have queued jobs on automatic bindings, so retry delays elapse
// without a heartbeat. Reads nothing when no job is queued.
export const sweepDemand: Sweep = async () => notImplemented();
