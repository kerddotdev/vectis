import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { Snapshot as SnapshotSchema } from "../../../packages/protocol/src/index.js";
import type { Environment, Snapshot, Operation } from "../../../packages/protocol/src/index.js";
import { instanceAdmissionError as admit, runnerCapacity as capacity } from "./runner-capacity.js";
import { estimatedVmMemoryMiB } from "../../../packages/runner/src/memory.js";
import type { ResourceProbe } from "./resource-probe.js";

const probe: ResourceProbe = (instances) => ({
  footprintsMiB: new Map(
    instances.map((instance) => [instance.id, Math.min(instance.memoryMiB ?? 2048, 2048)]),
  ),
  pressure: "normal",
  pressureKnown: true,
});
const runnerCapacity = (state: Snapshot, machine: typeof host) => capacity(state, machine, probe);
const instanceAdmissionError = (state: Snapshot, env: Environment, machine: typeof host) =>
  admit(state, env, machine, 1, probe);

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
  return {
    id: "instance",
    environmentId: env.id,
    status: "running",
    memoryMiB: env.memoryMiB,
    pid: 0,
    createdAt: "",
  };
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

test("five VMs with ceilings above host RAM and CPU cores admit another when footprints fit", () => {
  const env = { ...environment, cpu: 8 };
  const state = snapshot(env);
  state.instances = Array.from({ length: 5 }, (_, index) => ({
    ...running(),
    id: `vm${index}`,
    cpu: 8,
    pid: index + 1,
  }));
  expect(state.instances.length * environment.memoryMiB).toBeGreaterThan(
    host.memoryBytes / 1024 ** 2,
  );
  expect(instanceAdmissionError(state, env, host)).toBeUndefined();
  expect(runnerCapacity(state, host).budget).toEqual({
    memoryBudgetMiB: 36864,
    memoryCommittedMiB: 10240,
    hostMemoryMiB: 49152,
    pressure: "normal",
    pressureKnown: true,
  });
  expect(instanceAdmissionError(state, { ...environment, cpu: 15 }, host)).toMatchObject({
    code: "invalid_resources",
  });
});

test("admission uses measured footprints, floors, overrides and configured fallback", () => {
  const state = snapshot();
  state.machine.memoryBudgetMiB = 8192;
  state.instances = [{ ...running(), memoryMiB: 4096 }];
  const usage: ResourceProbe = () => ({
    footprintsMiB: new Map([["instance", 7000]]),
    pressure: "normal",
    pressureKnown: true,
  });
  expect(admit(state, environment, host, 1, usage)).toMatchObject({
    code: "memory_budget_exceeded",
    nextStep: expect.any(String),
  });
  expect(runnerCapacity(state, host).available).toBe(3);
  const missing: ResourceProbe = () => ({ ...probe([]), footprintsMiB: new Map() });
  expect(capacity(state, host, missing).budget?.memoryCommittedMiB).toBe(4096);
  expect(capacity(state, host, missing).available).toBe(2);
  state.instances = [running()];
  expect(admit(state, environment, host, 1, missing)).toMatchObject({
    code: "memory_budget_exceeded",
  });
  expect(capacity(state, host, missing).available).toBe(0);
});

test.each(["warning", "critical"] as const)(
  "%s memory pressure closes admission and slots",
  (pressure) => {
    const state = snapshot();
    const pressured: ResourceProbe = () => ({ ...probe([]), pressure });
    expect(admit(state, environment, host, 1, pressured)).toMatchObject({
      code: "memory_pressure",
      nextStep: expect.any(String),
    });
    expect(capacity(state, host, pressured)).toMatchObject({
      available: 0,
      budget: { pressure, pressureKnown: true },
    });
    const unknown: ResourceProbe = () => ({ ...probe([]), pressureKnown: false });
    expect(capacity(state, host, unknown)).toMatchObject({
      available: 5,
      budget: { pressure: "normal", pressureKnown: false },
    });
  },
);

test("per-environment slots share measured memory with OS startup estimates and one probe", () => {
  const state = snapshot();
  state.machine.memoryBudgetMiB = 10240;
  state.instances = [running()];
  state.environments = [
    environment,
    { ...environment, id: "mac", os: "macos" },
    { ...environment, id: "win", os: "windows" },
  ];
  const measured = vi.fn(probe);
  expect(capacity(state, host, measured).environments).toEqual([
    { environmentId: "linux", available: 4 },
    { environmentId: "mac", available: 2 },
    { environmentId: "win", available: 2 },
  ]);
  expect(measured).toHaveBeenCalledOnce();
});

test("a footprint below the startup floor still holds the floor", () => {
  const state = snapshot();
  state.instances = [running()];
  const low: ResourceProbe = () => ({ ...probe([]), footprintsMiB: new Map([["instance", 100]]) });
  expect(capacity(state, host, low).budget?.memoryCommittedMiB).toBe(2048);
  state.instances = [{ ...running(), status: "starting", pid: 0 }];
  const absent: ResourceProbe = () => ({ ...probe([]), footprintsMiB: new Map() });
  expect(capacity(state, host, absent).budget?.memoryCommittedMiB).toBe(2048);
  state.instances = [{ ...running(), status: "interrupted", pid: 0 }];
  expect(capacity(state, host, absent).budget?.memoryCommittedMiB).toBe(environment.memoryMiB);
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
  expect(runnerCapacity(state, host).available).toBe(5);
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
  state.machine.memoryBudgetMiB = 8192;
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
      { environmentId: "linux", available: 4 },
      { environmentId: "large", available: 4 },
    ],
  });
});

test.each([
  { ...environment },
  { ...environment, cpu: 1, memoryMiB: 18432 },
  { ...environment, os: "macos" as const, cpu: 1, memoryMiB: 512 },
])("capacity agrees with successive admission for $os / $cpu CPU / $memoryMiB MiB", (env) => {
  const state = snapshot(env);
  state.machine.memoryBudgetMiB = Math.max(2048, estimatedVmMemoryMiB(env) * 4);
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
  state.machine.memoryBudgetMiB = 4096;
  state.operations = [operation("accepted")];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.operations = [operation("accepted"), { ...operation("running"), id: "second" }];
  expect(runnerCapacity(state, host).available).toBe(0);
  state.instances = [running(), { ...running(), id: "other" }];
  expect(runnerCapacity(state, host).available).toBe(0);
});

test("starting and interrupted VMs hold only their own resources", () => {
  const state = snapshot();
  state.machine.memoryBudgetMiB = 4096;
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
    code: "memory_budget_exceeded",
  });
  state.operations = [];
  state.instances = [{ ...running(), status: "interrupted" }];
  expect(runnerCapacity(state, host).available).toBe(1);
  state.instances = [{ ...running(), status: "interrupted", cpu: host.cpus }];
  expect(runnerCapacity(state, host).available).toBe(1);
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
