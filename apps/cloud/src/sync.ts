import type { MachineHandler } from "./context.js";
import { bindingRecord, type BindingRow, type InspectionRow, type OperationRow } from "./db.js";
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
      env.DB.prepare(
        "SELECT * FROM repositoryBindings WHERE machineId = ? AND enabled = 1 ORDER BY verifiedAt DESC LIMIT 20",
      ).bind(machine.id),
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
  const bindings = (reads[4]!.results as unknown as BindingRow[]).map(bindingRecord);
  return {
    operations,
    inspections,
    repositories,
    observations,
    jobMarkers: await jobMarkers(env, bindings),
  };
};
