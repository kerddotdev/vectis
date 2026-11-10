import { expect, it } from "vitest";
import { env, machineRequest, seedAccount, seedBinding, seedMachine } from "../src/test-support.js";
import { submitOperation, cancelOperation } from "../src/operations.js";

it("returns one snapshot with active operations in creation order and only live pending inspections", async () => {
  const machine = await seedMachine();
  const first = await submitOperation(env, machine.owner, {
    machineId: machine.id,
    key: "first",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding" }),
  });
  const cancelled = await submitOperation(env, machine.owner, {
    machineId: machine.id,
    key: "cancelled",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding" }),
  });
  await cancelOperation(env, machine.owner, cancelled);
  await env.DB.prepare(
    "INSERT INTO inspections (id, owner, machineId, key, queryJson, expiresAt, pending) VALUES ('expired', ?, ?, 'expired', '{}', 0, 1)",
  )
    .bind(machine.owner, machine.id)
    .run();
  const response = await machineRequest("/machine/sync", machine.bearer, { leaseIds: [] });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    operations: [{ id: first, phase: "accepted", cancelRequested: false }],
    inspections: [],
    repositories: [],
    observations: [],
    jobMarkers: {},
  });
});

it("reports job markers for exactly the repositories the relay tracks", async () => {
  const machine = await seedMachine();
  const account = await seedAccount(machine.owner);
  const ids: string[] = [];
  for (let index = 0; index < 22; index++)
    ids.push(
      (
        await seedBinding({
          owner: machine.owner,
          accountId: account.id,
          machineId: machine.id,
          repositoryId: 1000 + index,
        })
      ).id,
    );
  // Re-verifying the oldest binding must not move it into the tracked window.
  await env.DB.prepare("UPDATE repositoryBindings SET verifiedAt = ? WHERE id = ?")
    .bind(Date.now() + 60_000, ids[0])
    .run();
  const response = await machineRequest("/machine/sync", machine.bearer, { leaseIds: [] });
  const snapshot = (await response.json()) as {
    repositories: { id: string }[];
    jobMarkers: Record<string, number | null>;
  };
  const tracked = snapshot.repositories.slice(-20).map(({ id }) => id);
  expect(tracked).toEqual(ids.slice(2));
  expect(Object.keys(snapshot.jobMarkers).sort()).toEqual([...tracked].sort());
});
