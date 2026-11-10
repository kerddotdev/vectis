import type { Env } from "./env.js";
import type { Sweep } from "./context.js";
import { sweepOperations } from "./operations.js";
import { sweepDemand } from "./runners/demand.js";
import { sweepLeases } from "./runners/leases.js";
import { sweepScaleSets } from "./runners/scale-sets.js";
import { sweepRedelivery } from "./github/redelivery.js";
import { sweepRetention } from "./retention.js";

// Two triggers replace Convex's scheduler: due rows are found by indexed timestamps, so a sweep
// with nothing due reads almost nothing. Sweeps run one after another so the invocation stays
// within its subrequest budget, and one failing sweep never blocks the others.
const schedules: Record<string, readonly Sweep[]> = {
  "*/2 * * * *": [sweepOperations, sweepLeases, sweepScaleSets, sweepRedelivery, sweepDemand],
  "0 3 * * *": [sweepRetention],
};

export async function runCron(env: Env, cron: string, now: number) {
  for (const sweep of schedules[cron] ?? []) {
    try {
      await sweep(env, now);
    } catch (error) {
      console.error("sweep failed", sweep.name, error);
    }
  }
}
