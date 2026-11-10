import { expect, it } from "vitest";
import { env, seedMachine, machineRequest } from "../src/test-support.js";
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
