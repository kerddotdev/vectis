import { expect, it } from "vitest";
import { env, seedMachine, machineRequest } from "../src/test-support.js";
import {
  submitOperation,
  cancelOperation,
  getOperation,
  sweepOperations,
} from "../src/operations.js";

it("creates once under concurrent submission and rejects conflicting keys and owners", async () => {
  const machine = await seedMachine();
  const input = {
    machineId: machine.id,
    key: "one",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding", automatic: true }),
  };
  const ids = await Promise.all([
    submitOperation(env, machine.owner, input),
    submitOperation(env, machine.owner, input),
  ]);
  expect(ids[0]).toBe(ids[1]);
  await expect(
    submitOperation(env, machine.owner, {
      ...input,
      commandJson: JSON.stringify({ type: "runner.run", bindingId: "other" }),
    }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(getOperation(env, "other", ids[0]!)).rejects.toMatchObject({
    code: "operation_missing",
  });
  expect((await getOperation(env, machine.owner, ids[0]!)).id).toBe(ids[0]);
});

it("guards acknowledgements, repeated results, and cancellation", async () => {
  const machine = await seedMachine();
  const id = await submitOperation(env, machine.owner, {
    machineId: machine.id,
    key: "ack",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding" }),
  });
  const ack = (phase: string, resultJson?: string) =>
    machineRequest("/machine/operations/acknowledge", machine.bearer, {
      id,
      phase,
      ...(resultJson ? { resultJson } : {}),
    });
  expect((await ack("running")).status).toBe(409);
  const results = await Promise.all([ack("claimed"), ack("claimed")]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect((await ack("running")).status).toBe(200);
  expect((await ack("succeeded", "{}")).status).toBe(200);
  expect((await ack("succeeded", "{}")).status).toBe(200);
  expect(await (await ack("succeeded", '{"x":1}')).json()).toMatchObject({
    code: "acknowledgement_conflict",
  });
  const cancelled = await submitOperation(env, machine.owner, {
    machineId: machine.id,
    key: "cancel",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding" }),
  });
  await cancelOperation(env, machine.owner, cancelled);
  expect(
    await (
      await machineRequest("/machine/operations/acknowledge", machine.bearer, {
        id: cancelled,
        phase: "claimed",
      })
    ).json(),
  ).toMatchObject({ code: "operation_cancelled" });
});

it("expires unclaimed offline runner operations after two minutes", async () => {
  const machine = await seedMachine();
  const id = await submitOperation(env, machine.owner, {
    machineId: machine.id,
    key: "expire",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding" }),
  });
  const row = await getOperation(env, machine.owner, id);
  await sweepOperations(env, row.createdAt + 120001);
  const expired = await getOperation(env, machine.owner, id);
  expect(expired.phase).toBe("cancelled");
  expect(JSON.parse(expired.resultJson!)).toMatchObject({ code: "machine_offline" });
});
