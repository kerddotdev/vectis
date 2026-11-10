import type { MachineHandler } from "./context.js";
import type { InspectionRow, OperationRow } from "./db.js";
import { machineRepositories } from "./github/repositories.js";
import { jobMarkers, leaseObservations } from "./github/jobs.js";

export const sync: MachineHandler<"/machine/sync"> = async ({ env, machine }, input) => {
  const now = Date.now();
  const [reads, repositories, observations] = await Promise.all([
    env.DB.batch([
      ...["accepted", "claimed", "running"].map((phase) =>
        env.DB.prepare(
          "SELECT * FROM operations WHERE machineId = ? AND phase = ? ORDER BY createdAt LIMIT 100",
        ).bind(machine.id, phase),
      ),
      env.DB.prepare(
        "SELECT id, queryJson FROM inspections WHERE machineId = ? AND pending = 1 AND expiresAt > ? LIMIT 20",
      ).bind(machine.id, now),
    ]),
    machineRepositories(env, machine),
    leaseObservations(env, machine, input.leaseIds),
  ]);
  const operations = reads
    .slice(0, 3)
    .flatMap((result) => result.results as unknown as OperationRow[])
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row) => ({
      id: row.id,
      commandJson: row.commandJson,
      phase: row.phase,
      cancelRequested: row.cancelRequested === 1,
      createdAt: row.createdAt,
    }));
  const inspections = (reads[3]!.results as unknown as InspectionRow[]).map(
    ({ id, queryJson }) => ({ id, queryJson }),
  );
  return {
    operations,
    inspections,
    repositories,
    observations,
    // The relay tracks job lists for the last 20 repositories in this order.
    jobMarkers: await jobMarkers(
      env,
      repositories
        .slice(-20)
        .flatMap(({ id, installationId, repositoryId }) =>
          installationId === undefined ? [] : [{ id, installationId, repositoryId }],
        ),
    ),
  };
};
