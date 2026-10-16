import { expect, test } from "vitest";
import { Schema } from "effect";
import { decodeCommand, Machine, Request, RunnerCapacity } from "./index.js";
import { ControllerRequest } from "./controller.js";

test.each([
  { memoryBudgetMiB: 2048 },
  { memoryBudgetMiB: 36864 },
  { memoryBudgetMiB: 8192, maxRunners: 16 },
  { maxRunners: 5 },
])("machine settings cross local and controller command boundaries: %j", (settings) => {
  const command = { type: "machine.configure", ...settings };
  expect(decodeCommand(command)).toEqual(command);
  expect(Schema.decodeUnknownSync(Request)({ key: "settings", command }).command).toEqual(command);
  expect(
    Schema.decodeUnknownSync(ControllerRequest)({
      type: "operation.submit",
      machineId: "host",
      key: "settings",
      command,
    }),
  ).toMatchObject({ command });
});

test.each([0, 2047, -1, 2048.5, "2048", Infinity, NaN])(
  "invalid memory budget %s is rejected",
  (memoryBudgetMiB) => {
    expect(() => decodeCommand({ type: "machine.configure", memoryBudgetMiB })).toThrow();
  },
);

test("old machine and capacity snapshots remain valid and command JSON schema includes the budget", () => {
  expect(
    Schema.decodeUnknownSync(Machine)({ id: "host", name: "Test", paused: false }),
  ).not.toHaveProperty("memoryBudgetMiB");
  expect(
    Schema.decodeUnknownSync(RunnerCapacity)({ max: 5, active: 0, available: 0 }),
  ).not.toHaveProperty("budget");
  const schema = JSON.stringify(Schema.toJsonSchemaDocument(Request));
  expect(schema).toContain('"memoryBudgetMiB"');
  expect(schema).toContain('"minimum":2048');
});
