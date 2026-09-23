import { expect, test } from "vitest";
import type { Environment, Snapshot, Operation } from "../../../packages/protocol/src/index.js";
import { instanceAdmissionError, runnerCapacity } from "./runner-capacity.js";

const host = { cpus: 14, memoryBytes: 48 * 1024 ** 3 };
const environment: Environment = {
  id: "linux",
  name: "Linux",
  os: "linux",
  basePath: "/isolated/base",
  cpu: 6,
  memoryMiB: 12288,
  state: "ready",
};
function snapshot(env = environment) {
  const base: Snapshot = {
    protocolVersion: 1,
    machine: { id: "self", name: "Test", paused: false },
    environments: [env],
    instances: [],
    operations: [],
  };
  return { ...base, machine: { ...base.machine } };
}
function running(env = environment): Snapshot["instances"][number] {
  return { id: "instance", environmentId: env.id, status: "running", pid: 0, createdAt: "" };
}
function operation(status: Operation["status"], command = "runner.run"): Operation {
  return { id: status, key: status, command, status, createdAt: "", updatedAt: "", message: "" };
}

test("defaults to five runners and counts only unfinished runner operations", () => {
  const state = snapshot({ ...environment, cpu: 1, memoryMiB: 512 });
  state.operations = (
    ["accepted", "running", "action_required", "succeeded", "failed", "cancelled"] as const
  ).map((status) => operation(status));
  expect(runnerCapacity(state, host)).toEqual({ max: 5, active: 3, available: 2 });
  state.machine.maxRunners = 2;
  expect(runnerCapacity(state, host)).toEqual({ max: 2, active: 3, available: 0 });
});

test("CPU budget accounts for running instances and their resource overrides", () => {
  const state = snapshot();
  state.instances = [running()];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [{ ...running(), cpu: 10, memoryMiB: 512 }];
  expect(runnerCapacity(state, host).available).toBe(0);
});

test("memory budget allows at most 75 percent of host memory", () => {
  const env = { ...environment, cpu: 1, memoryMiB: 18432 };
  const state = snapshot(env);
  expect(runnerCapacity(state, host).available).toBe(2);
  state.instances = [running(env)];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [{ ...running(env), memoryMiB: 18433 }];
  expect(runnerCapacity(state, host).available).toBe(0);
});

test("macOS admits only two instances while stopped instances consume no capacity", () => {
  const env: Environment = { ...environment, os: "macos", cpu: 1, memoryMiB: 512 };
  const state = snapshot(env);
  expect(runnerCapacity(state, host).available).toBe(2);
  state.instances = [running(env), { ...running(env), id: "stopped", status: "stopped" }];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [running(env), { ...running(env), id: "second" }];
  expect(runnerCapacity(state, host).available).toBe(0);
  expect(instanceAdmissionError(state, env, host)).toMatchObject({ code: "macos_limit" });
});

test.each([
  "environment.prepare-linux",
  "environment.resume",
  "environment.install-macos",
  "environment.install-windows",
  "environment.resume-windows",
  "environment.resume-macos",
  "environment.open-macos-setup",
])("busy preparation %s prevents runner admission", (command) => {
  for (const status of ["accepted", "running"] as const) {
    const state = snapshot();
    state.operations = [operation(status, command)];
    expect(runnerCapacity(state, host).available).toBe(0);
  }
  const state = snapshot();
  state.operations = [operation("action_required", command)];
  expect(runnerCapacity(state, host).available).toBe(2);
});

test("preparation flag, pause and missing ready environments report no available slots", () => {
  const state = snapshot();
  expect(runnerCapacity({ ...state, preparationBusy: true }, host).available).toBe(0);
  expect(
    runnerCapacity({ ...state, machine: { ...state.machine, paused: true } }, host).available,
  ).toBe(0);
  expect(runnerCapacity({ ...state, environments: [] }, host).available).toBe(0);
  expect(
    runnerCapacity({ ...state, environments: [{ ...environment, state: "action_required" }] }, host)
      .available,
  ).toBe(0);
});

test("largest ready environment is selected by CPU then memory", () => {
  const state = snapshot();
  state.environments = [
    { ...environment, id: "small", cpu: 1, memoryMiB: 512 },
    environment,
    { ...environment, id: "large", memoryMiB: 24576 },
    { ...environment, id: "unready", cpu: 100, state: "action_required" },
  ];
  expect(runnerCapacity(state, host).available).toBe(1);
});

test.each([
  { ...environment },
  { ...environment, cpu: 1, memoryMiB: 18432 },
  { ...environment, os: "macos" as const, cpu: 1, memoryMiB: 512 },
])("capacity agrees with successive admission for $os / $cpu CPU / $memoryMiB MiB", (env) => {
  const state = snapshot(env);
  state.instances = [running(env)];
  const { available } = runnerCapacity(state, host);
  for (let index = 0; index < available; index++) {
    expect(instanceAdmissionError(state, env, host)).toBeUndefined();
    state.instances = [...state.instances, { ...running(env), id: `extra${index}` }];
  }
  expect(instanceAdmissionError(state, env, host)).toBeDefined();
});

test("accepted runners reserve their VM before it boots, so slots are not offered twice", () => {
  const state = snapshot();
  state.operations = [operation("accepted")];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.operations = [operation("accepted"), { ...operation("running"), id: "second" }];
  expect(runnerCapacity(state, host).available).toBe(0);
  state.instances = [running(), { ...running(), id: "other" }];
  expect(runnerCapacity(state, host).available).toBe(0);
});
