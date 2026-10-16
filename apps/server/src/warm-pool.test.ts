import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Environment, Instance } from "../../../packages/protocol/src/index.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { runnerCapacity, instanceAdmissionError } from "./runner-capacity.js";
import { Store, type StoreOptions } from "./store.js";
import { WarmPool } from "./warm-pool.js";

vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.resetAllMocks();
});
const environment: Environment = {
  id: "linux",
  name: "Linux",
  os: "linux",
  state: "ready",
  basePath: "/unused/base",
  cpu: 1,
  memoryMiB: 512,
  warmPool: 2,
};
const connection = {
  host: "192.0.2.1",
  port: 22,
  user: "test",
  identityFile: "/unused/key",
  knownHostsFile: "/unused/hosts",
  hostKeyAlias: "test",
};
const host = { cpus: 8, memoryBytes: 8 * 1024 ** 3 };
const probe = () => ({
  footprintsMiB: new Map<string, number>(),
  pressure: "normal" as const,
  pressureKnown: true,
});

async function fixture(
  options: StoreOptions & { max?: number; budget?: number; memory?: number } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "vectis-warm-pool-"));
  const store = new Store(join(home, "state.sqlite"), options);
  store.put("machine", "self", {
    id: "self",
    name: "Test",
    paused: false,
    maxRunners: options.max ?? 5,
    memoryBudgetMiB: options.budget ?? 4096,
  });
  store.put("environment", environment.id, { ...environment, memoryMiB: options.memory ?? 512 });
  let now = Date.now();
  let pressure: "normal" | "warning" | "critical" = "normal";
  const footprintsMiB = new Map<string, number>();
  const resources = () => ({ ...probe(), footprintsMiB, pressure });
  const start = vi.fn(
    async (env: Environment, key: string, signal: AbortSignal): Promise<Instance> => {
      signal.throwIfAborted();
      const operation = store.accept(key, key, "environment.start").operation;
      const instance: Instance = {
        id: operation.id,
        environmentId: env.id,
        status: "running",
        role: "warming",
        memoryMiB: env.memoryMiB,
        pid: 0,
        createdAt: new Date(now).toISOString(),
      };
      store.put("instance", instance.id, instance);
      store.update(operation, { status: "succeeded" });
      return instance;
    },
  );
  const stop = vi.fn(async (instance: Instance) => {
    const current = store.snapshot().instances.find((item) => item.id === instance.id);
    store.put("instance", instance.id, { ...current, status: "stopped", pid: 0 });
  });
  vi.mocked(readyGuest).mockResolvedValue(connection);
  const error = vi.fn();
  const pool = new WarmPool(store, {
    start,
    stop,
    now: () => now,
    admission: (snapshot, env, count) =>
      instanceAdmissionError(snapshot, env, host, count, resources),
    capacity: (snapshot) => runnerCapacity(snapshot, host, { probe: resources }),
    onError: error,
  });
  cleanups.push(async () => {
    await pool.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const warm = () =>
    store.snapshot().instances.filter((item) => item.status === "running" && item.role === "warm");
  const runner = (key: string) => {
    const operation = store.accept(key, key, "runner.run").operation;
    return store.update(operation, {
      status: "running",
      result: {
        bindingId: "binding",
        environmentId: environment.id,
        leaseKey: key,
        stage: "starting",
      },
    });
  };
  return {
    store,
    pool,
    start,
    stop,
    warm,
    runner,
    error,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
    setFootprint: (id: string, memoryMiB: number) => footprintsMiB.set(id, memoryMiB),
    setPressure: (value: typeof pressure) => {
      pressure = value;
    },
  };
}

test("pressure prevents pool filling until normal pressure returns", async () => {
  const f = await fixture();
  f.setPressure("critical");
  f.pool.start();
  expect(f.pool.canFill(environment)).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
  f.setPressure("normal");
  f.pool.refresh();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
});

test("failed ownership persistence rolls the claim back without losing the warm VM", async () => {
  const f = await fixture();
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  const operation = f.runner("claim");
  const update = vi.spyOn(f.store, "update").mockImplementationOnce(() => {
    throw new Error("write failed");
  });
  expect(() => f.pool.claim(environment.id, operation)).toThrow("write failed");
  update.mockRestore();
  expect(f.warm()).toHaveLength(2);
  expect(f.pool.claim(environment.id, operation)?.instance).toBeDefined();
});

test("fills to N with SSH-ready, runner-less children and stops owned VMs on shutdown", async () => {
  const f = await fixture();
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(
    f.store
      .snapshot()
      .operations.every(
        (op) => op.key.startsWith("warm:linux:") && op.command === "environment.start",
      ),
  ).toBe(true);
  expect(runnerCapacity(f.store.snapshot(), host, { probe })).toMatchObject({
    active: 0,
    available: 5,
    budget: { memoryCommittedMiB: 1024 },
  });
  await f.pool.close();
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.warm()).toHaveLength(0);
});

test.each([{ max: 2 }, { budget: 2048, memory: 1024 }])(
  "leaves the last slot and startup estimate free: %j",
  async (options) => {
    const f = await fixture(options);
    f.pool.start();
    await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
    expect(f.pool.canFill(f.store.snapshot().environments[0]!)).toBe(false);
  },
);

test("queued runners prevent pool admission and preparation or pause prevents filling", async () => {
  const f = await fixture();
  const operation = f.store.accept("queued", "queued", "runner.run").operation;
  f.pool.start();
  expect(f.pool.canFill(environment)).toBe(false);
  f.store.update(operation, { status: "cancelled" });
  const machine = f.store.snapshot().machine;
  f.store.put("machine", "self", { ...machine, paused: true });
  expect(f.pool.canFill(environment)).toBe(false);
  f.store.put("machine", "self", machine);
  f.store.accept("prepare", "prepare", "environment.prepare-linux");
  expect(f.pool.canFill(environment)).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
});

test("does not mark a VM warm before readiness and cancels readiness for queued work", async () => {
  const f = await fixture();
  vi.mocked(readyGuest).mockImplementation(async (_env, _instance, signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    signal.throwIfAborted();
    return connection;
  });
  f.pool.start();
  await vi.waitFor(() => expect(readyGuest).toHaveBeenCalledOnce());
  expect(f.warm()).toHaveLength(0);
  f.runner("queued");
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  expect(f.store.snapshot().instances.every((item) => item.status === "stopped")).toBe(true);
});

test("concurrent runners claim a VM exactly once and persist ownership with the claim", async () => {
  const f = await fixture();
  f.store.put("environment", environment.id, { ...environment, warmPool: 1 });
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  const id = f.warm()[0]!.id;
  const operations = [f.runner("one"), f.runner("two")];
  const claims = await Promise.all(
    operations.map(async (operation) => f.pool.claim(environment.id, operation)),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims[0]?.instance).toMatchObject({ id, role: undefined });
  expect(claims[0]?.connection).toBe(connection);
  expect(
    f.store.snapshot().operations.find((op) => op.id === operations[0]!.id)?.result,
  ).toMatchObject({ instanceId: id });
  await f.pool.close();
  expect(f.stop).not.toHaveBeenCalled();
});

test("recycles at 30 minutes and refuses an aged or backwards-clock claim", async () => {
  const f = await fixture();
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  const ids = f.warm().map((item) => item.id);
  const now = f.now();
  f.setNow(now - 1);
  const runner = f.runner("clock");
  expect(f.pool.claim(environment.id, runner)).toBeUndefined();
  f.store.update(runner, { status: "cancelled" });
  f.setNow(now + 30 * 60 * 1000);
  f.pool.refresh();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  expect(f.warm().every((item) => !ids.includes(item.id))).toBe(true);
  expect(f.stop).toHaveBeenCalledTimes(2);
});

test("yields other environments' warm VMs when a real job needs memory", async () => {
  const f = await fixture({ budget: 2048 });
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  const other = { ...environment, id: "other", memoryMiB: 1536, warmPool: 0 };
  f.store.put("environment", other.id, other);
  f.runner("real");
  expect(instanceAdmissionError(f.store.snapshot(), other, host, 1, probe)?.code).toBe(
    "memory_budget_exceeded",
  );
  await f.pool.yieldForJob(other);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(instanceAdmissionError(f.store.snapshot(), other, host, 1, probe)).toBeUndefined();
});

test.each(["disabled", "paused", "configuration"])("drains the pool when %s", async (change) => {
  const f = await fixture();
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  if (change === "paused")
    f.store.put("machine", "self", { ...f.store.snapshot().machine, paused: true });
  else
    f.store.put("environment", environment.id, {
      ...environment,
      warmPool: change === "disabled" ? 0 : 2,
      cpu: change === "configuration" ? 2 : 1,
    });
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(2));
  if (change !== "configuration") expect(f.warm()).toHaveLength(0);
});

test("failed warm cleanup retains resource reservations and does not spin retries", async () => {
  const f = await fixture();
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  f.stop.mockRejectedValueOnce(new Error("unconfirmed"));
  f.store.put("environment", environment.id, { ...environment, warmPool: 0 });
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledOnce());
  expect(
    f.store
      .snapshot()
      .instances.some((item) => item.status === "running" && item.role === undefined),
  ).toBe(true);
  expect(
    runnerCapacity(f.store.snapshot(), host, { probe }).budget?.memoryCommittedMiB,
  ).toBeGreaterThanOrEqual(512);
});

test("pressure and the shared macOS limit block warm admission", async () => {
  const f = await fixture();
  const mac = { ...environment, os: "macos" as const };
  f.store.put("environment", environment.id, mac);
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  expect(f.pool.canFill(mac)).toBe(false);
  const state = f.store.snapshot();
  const pressured = () => ({ ...probe(), pressure: "critical" as const });
  expect(instanceAdmissionError(state, mac, host, 1, pressured)?.code).toBe("memory_pressure");
});

test("disabled pools stay dormant and still react to later configuration changes", async () => {
  const f = await fixture();
  f.store.put("environment", environment.id, { ...environment, warmPool: 0 });
  vi.useFakeTimers();
  try {
    f.pool.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(f.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.store.put("environment", environment.id, { ...environment, warmPool: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.warm()).toHaveLength(1);
    f.store.put("environment", environment.id, { ...environment, warmPool: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.warm()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("cold jobs can reclaim their own environment's warm VMs when measured memory no longer fits", async () => {
  const f = await fixture({ budget: 2048 });
  f.pool.start();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  for (const instance of f.warm()) f.setFootprint(instance.id, 900);
  f.runner("cache-cold");
  await f.pool.yieldForJob(environment);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.warm()).toHaveLength(1);
});

test("a disabled pool does not rebuild status on each retained history write", async () => {
  const f = await fixture();
  f.store.put("environment", environment.id, { ...environment, warmPool: 0 });
  const snapshot = vi.spyOn(f.store, "snapshot");
  try {
    f.pool.start();
    for (let index = 0; index < 20; index++) {
      f.store.put("operation", `history-${index}`, {
        id: `history-${index}`,
        key: `history-${index}`,
        command: "job.scan",
        status: "succeeded",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "Completed.",
      });
    }
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
  }
});

test("a running legacy runner does not block pool filling when its start leaves the status window", async () => {
  const snapshotLimits = { operations: 3, activities: 3, stoppedInstances: 2 };
  const f = await fixture({ snapshotLimits });
  const runner = f.runner("legacy");
  const start = f.store.accept(`${runner.id}:start`, "start", "environment.start").operation;
  f.store.update(start, { status: "succeeded" });
  f.store.put("instance", start.id, {
    id: start.id,
    environmentId: environment.id,
    status: "running",
    memoryMiB: 512,
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  for (let index = 0; index < snapshotLimits.operations; index++) {
    const operation = f.store.accept(`later-${index}`, `later-${index}`, "job.scan").operation;
    f.store.update(operation, { status: "succeeded" });
  }
  const snapshot = f.store.snapshot();
  expect(snapshot.operations).toHaveLength(snapshotLimits.operations + 1);
  expect(snapshot.operations).toContainEqual(expect.objectContaining({ id: runner.id }));
  expect(snapshot.operations.some((operation) => operation.id === start.id)).toBe(false);
  expect(f.store.operationByKey(`${runner.id}:start`)).toMatchObject({ id: start.id });
  expect(f.pool.canFill(environment)).toBe(true);
});

test.each(["accepted", "running", "action_required"] as const)(
  "%s provisioning reserves capacity and prevents warm pool startup",
  async (status) => {
    const f = await fixture();
    const operation = f.store.accept("provision", "provision", "environment.provision").operation;
    f.store.update(operation, { status });
    if (status === "action_required")
      f.store.put("provision", operation.id, {
        id: operation.id,
        environmentId: "derived",
        directory: "/unused/derived",
      });
    f.pool.start();
    expect(f.pool.canFill(environment)).toBe(false);
    expect(runnerCapacity(f.store.snapshot(), host, { probe }).available).toBe(0);
    expect(f.start).not.toHaveBeenCalled();
    f.store.remove("provision", operation.id);
    f.store.update(operation, { status: "failed" });
    await vi.waitFor(() => expect(f.warm()).toHaveLength(2));
  },
);
