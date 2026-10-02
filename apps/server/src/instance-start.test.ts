import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

test("a booting VM admits concurrent starts within budget and allows pause and cancellation", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-pending-start-"));
  const store = new Store(":memory:");
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validation = vi.spyOn(runtime, "validate").mockImplementation(() => pending);
  store.put("environment", "test", {
    id: "test",
    name: "Test",
    os: "linux",
    state: "ready",
    basePath: join(home, "base.img"),
    cpu: 1,
    memoryMiB: 512,
  });
  try {
    const start = service.submit("start", { type: "environment.start", id: "test" });
    await service.drain();
    expect(validation).toHaveBeenCalledOnce();
    expect(store.snapshot().instances[0]).toMatchObject({ id: start.id, status: "starting" });
    expect(service.submit("start", { type: "environment.start", id: "test" }).id).toBe(start.id);
    const second = service.submit("second", { type: "environment.start", id: "test" });
    const reconcile = service.submit("reconcile", { type: "instance.reconcile", id: start.id });
    service.submit("pause", { type: "machine.pause", paused: true });
    service.submit("cancel", { type: "operation.cancel", id: start.id });
    service.submit("cancel-second", { type: "operation.cancel", id: second.id });
    await service.drain();
    const snapshot = store.snapshot();
    expect(snapshot.machine.paused).toBe(true);
    expect(snapshot.operations.find((item) => item.id === start.id)?.status).toBe("running");
    expect(snapshot.operations.find((item) => item.id === second.id)?.status).toBe("running");
    expect(snapshot.operations.find((item) => item.id === reconcile.id)?.result).toMatchObject({
      code: "instance_starting",
    });
    expect(snapshot.instances.map((item) => item.status)).toEqual(["starting", "starting"]);
    release();
    for (const id of [start.id, second.id])
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === id)?.status).toBe(
          "cancelled",
        ),
      );
    expect(store.snapshot().instances.map((item) => item.status)).toEqual(["stopped", "stopped"]);
    expect(await runtime.hasWorkDirectory(start.id)).toBe(false);
    expect(validation).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await service.close();
    validation.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a booting VM keeps its resources, so a start beyond the budget is refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-budget-start-"));
  const store = new Store(":memory:");
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validation = vi.spyOn(runtime, "validate").mockImplementation(() => pending);
  store.put("environment", "test", {
    id: "test",
    name: "Test",
    os: "linux",
    state: "ready",
    basePath: join(home, "base.img"),
    cpu: Math.floor(cpus().length / 2) + 1,
    memoryMiB: 512,
  });
  try {
    const start = service.submit("start", { type: "environment.start", id: "test" });
    const second = service.submit("second", { type: "environment.start", id: "test" });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === second.id)).toMatchObject({
      status: "failed",
      result: { code: "capacity_exceeded" },
    });
    expect(store.snapshot().instances).toHaveLength(1);
    service.submit("cancel", { type: "operation.cancel", id: start.id });
    await service.drain();
    release();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === start.id)?.status).toBe(
        "cancelled",
      ),
    );
  } finally {
    release();
    await service.close();
    validation.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an interrupted instance from a previous service run blocks new VMs until reconciled", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-interrupted-start-"));
  const store = new Store(":memory:");
  store.put("instance", "lost", {
    id: "lost",
    environmentId: "test",
    status: "starting",
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  const reconcile = vi.spyOn(runtime, "reconcile").mockResolvedValue(false);
  store.put("environment", "test", {
    id: "test",
    name: "Test",
    os: "linux",
    state: "ready",
    basePath: join(home, "base.img"),
    cpu: 1,
    memoryMiB: 512,
  });
  try {
    await service.initialize();
    expect(store.snapshot().instances[0]).toMatchObject({ id: "lost", status: "interrupted" });
    const start = service.submit("start", { type: "environment.start", id: "test" });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === start.id)).toMatchObject({
      status: "action_required",
      result: { code: "reconciliation_required" },
    });
    expect(service.snapshot().runnerCapacity?.available).toBe(0);
  } finally {
    await service.close();
    reconcile.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("failed storage preflight releases capacity without reading an inaccessible work path", async () => {
  const { VectisError } = await import("../../../packages/protocol/src/index.js");
  const home = await mkdtemp(join(tmpdir(), "vectis-access-start-"));
  const store = new Store(":memory:");
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  const start = vi
    .spyOn(runtime, "start")
    .mockRejectedValue(
      new VectisError("storage_access_required", "Access denied", "Allow the selected volume."),
    );
  const inspect = vi.spyOn(runtime, "hasWorkDirectory");
  store.put("environment", "test", {
    id: "test",
    name: "Test",
    os: "linux",
    state: "ready",
    basePath: join(home, "base.img"),
    cpu: 1,
    memoryMiB: 512,
  });
  try {
    const operation = service.submit("start", { type: "environment.start", id: "test" });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
        status: "action_required",
        result: { code: "storage_access_required", nextStep: "Allow the selected volume." },
      }),
    );
    expect(store.snapshot().instances[0]).toMatchObject({ status: "stopped", pid: 0 });
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    await service.close();
    start.mockRestore();
    inspect.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
