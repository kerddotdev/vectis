import { expect, test } from "vitest";
import { Schema } from "effect";
import { Snapshot as SnapshotSchema } from "../../../packages/protocol/src/index.js";
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
  expect(runnerCapacity(state, host)).toMatchObject({ max: 5, active: 2, available: 3 });
  state.machine.maxRunners = 2;
  expect(runnerCapacity(state, host)).toMatchObject({ max: 2, active: 2, available: 0 });
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

test("scalar capacity is the maximum available across ready environments", () => {
  const state = snapshot();
  state.environments = [
    { ...environment, id: "small", cpu: 1, memoryMiB: 512 },
    environment,
    { ...environment, id: "large", memoryMiB: 24576 },
    { ...environment, id: "unready", cpu: 100, state: "action_required" },
  ];
  expect(runnerCapacity(state, host)).toMatchObject({
    available: 5,
    environments: [
      { environmentId: "small", available: 5 },
      { environmentId: "linux", available: 2 },
      { environmentId: "large", available: 1 },
    ],
  });
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

test("starting and interrupted VMs hold only their own resources", () => {
  const state = snapshot();
  state.operations = [
    operation("running"),
    { ...operation("succeeded", "environment.start"), id: "instance", key: "running:start" },
  ];
  state.instances = [{ ...running(), status: "starting" }];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [
    { ...running(), status: "starting" },
    { ...running(), id: "second" },
  ];
  expect(instanceAdmissionError(state, environment, host)).toMatchObject({
    code: "capacity_exceeded",
  });
  state.operations = [];
  state.instances = [{ ...running(), status: "interrupted" }];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [{ ...running(), status: "interrupted", cpu: host.cpus }];
  expect(runnerCapacity(state, host).available).toBe(0);
});

test("macOS limits apply across macOS environments without blocking Linux or Windows", () => {
  const small = { ...environment, cpu: 1, memoryMiB: 512 };
  const mac: Environment = { ...small, id: "mac", os: "macos" };
  const state = snapshot(small);
  state.environments = [small, mac, { ...mac, id: "mac2" }, { ...small, id: "win", os: "windows" }];
  state.instances = [running(mac), { ...running(mac), id: "other", status: "interrupted" }];
  const capacity = runnerCapacity(state, host);
  expect(capacity.environments).toEqual([
    { environmentId: "linux", available: 5 },
    { environmentId: "mac", available: 0 },
    { environmentId: "mac2", available: 0 },
    { environmentId: "win", available: 5 },
  ]);
  expect(
    Schema.decodeUnknownSync(SnapshotSchema)({ ...state, runnerCapacity: capacity }).runnerCapacity,
  ).toEqual(capacity);
});

test.each(["starting", "running", "interrupted", "stopped"] as const)(
  "an action-required runner with a %s child VM holds capacity only until verified stopped",
  (status) => {
    const state = snapshot({ ...environment, cpu: 1, memoryMiB: 512 });
    state.operations = [
      operation("action_required"),
      {
        ...operation("succeeded", "environment.start"),
        id: "instance",
        key: "action_required:start",
      },
    ];
    state.instances = [{ ...running(), cpu: 1, memoryMiB: 512, status }];
    expect(runnerCapacity(state, host)).toMatchObject({
      active: status === "stopped" ? 0 : 1,
      available: status === "stopped" ? 5 : 4,
    });
  },
);

test("missing instance evidence after a start still holds a runner slot", () => {
  const state = snapshot({ ...environment, cpu: 1, memoryMiB: 512 });
  state.operations = [
    operation("action_required"),
    { ...operation("succeeded", "environment.start"), key: "action_required:start" },
  ];
  expect(runnerCapacity(state, host).active).toBe(1);
});

test("runner progress identifies boot reservations and a stopped VM without a retained child", () => {
  const mac: Environment = { ...environment, id: "mac", os: "macos", cpu: 1, memoryMiB: 512 };
  const state = snapshot(mac);
  state.environments = [mac, { ...environment, cpu: 1, memoryMiB: 512 }];
  state.instances = [running(mac)];
  state.operations = [
    {
      ...operation("running"),
      result: {
        bindingId: "binding",
        environmentId: "mac",
        leaseKey: "running",
        stage: "starting",
      },
    },
  ];
  expect(runnerCapacity(state, host).environments).toEqual([
    { environmentId: "mac", available: 0 },
    { environmentId: "linux", available: 4 },
  ]);
  state.instances = [{ ...running(mac), status: "stopped" }];
  state.operations = [
    {
      ...operation("action_required"),
      result: {
        bindingId: "binding",
        environmentId: "mac",
        leaseKey: "running",
        instanceId: "instance",
        stage: "cleaning",
      },
    },
  ];
  expect(runnerCapacity(state, host)).toMatchObject({ active: 0, available: 5 });
});
