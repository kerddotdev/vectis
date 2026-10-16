import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { RunnerBroker } from "../../../packages/protocol/src/runners.js";
import { activityFor } from "./activities.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.length = 0;
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-runner-recovery-"));
  homes.push(home);
  const store = new Store(":memory:");
  const broker = {
    connectRepository: vi.fn(async () => "binding"),
    disconnectRepository: async () => {},
    setAccess: async () => {},
    setAutomatic: vi.fn(async () => {}),
    analyzeMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    publishMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    jobLogs: async () => {
      throw new Error("Unexpected job log read.");
    },
    scanJobs: vi.fn(async () => ({ runs: 0, jobs: 0, complete: true })),
    controlRun: async () => {
      throw new Error("unused");
    },
    refreshJob: vi.fn(async () => ({
      jobId: 1,
      runId: 2,
      name: "Build",
      runnerId: null,
      runnerName: null,
      updatedAt: 1,
      labels: [],
      status: "completed" as const,
      conclusion: "success",
    })),
    reconcileRunner: vi.fn<RunnerBroker["reconcileRunner"]>(async () => ({
      id: "lease",
      bindingId: "binding",
      environmentId: "test",
      phase: "ready",
    })),
    prepareRunner: vi.fn<RunnerBroker["prepareRunner"]>(),
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    releaseRunner: vi.fn<RunnerBroker["releaseRunner"]>(async () => {}),
    repositories: async () => [],
  };
  const service = new Service(store, new VmRuntime({ home }), () => broker);
  const interrupted = store.accept(
    "original",
    "fingerprint",
    "runner.run",
    activityFor("runner", { type: "runner.run", bindingId: "binding" }),
    "runner",
  ).operation;
  store.update(interrupted, {
    status: "action_required",
    result: {
      bindingId: "binding",
      environmentId: "test",
      leaseKey: interrupted.id,
      instanceId: "instance",
      stage: "registering",
    },
  });
  store.put("instance", "instance", {
    id: "instance",
    environmentId: "test",
    status: "stopped",
    pid: 0,
    createdAt: "now",
  });
  return { store, service, broker, interrupted, runtime: service.runtime };
}
test("reconciles a lost registration response without preparing another runner", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    const operation = service.submit("recover", { type: "runner.reconcile", id: interrupted.id });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
      "succeeded",
    );
    expect(store.snapshot().operations.find((item) => item.id === interrupted.id)?.status).toBe(
      "cancelled",
    );
    expect(broker.prepareRunner).not.toHaveBeenCalled();
    expect(broker.reconcileRunner).toHaveBeenCalledWith(
      { bindingId: "binding", environmentId: "test", key: interrupted.id },
      expect.any(AbortSignal),
    );
    expect(broker.releaseRunner).toHaveBeenCalledWith("lease", expect.any(AbortSignal));
    expect(store.snapshot().activities?.find((item) => item.id === interrupted.id)?.status).toBe(
      "cancelled",
    );
    expect(store.get("operation", operation.id)).toMatchObject({ activityId: interrupted.id });
  } finally {
    await service.close();
    store.close();
  }
});
test("does not remove a lease while VM exit is unconfirmed", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    store.put("instance", "instance", {
      id: "instance",
      environmentId: "test",
      status: "interrupted",
      pid: 42,
      createdAt: "now",
    });
    const operation = service.submit("recover", { type: "runner.reconcile", id: interrupted.id });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
      "action_required",
    );
    expect(broker.reconcileRunner).not.toHaveBeenCalled();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
  }
});
test("rejects a mismatched cloud lease and leaves the original operation unresolved", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    broker.reconcileRunner.mockResolvedValue({
      id: "foreign",
      bindingId: "other",
      environmentId: "test",
      phase: "ready",
    });
    service.submit("recover", { type: "runner.reconcile", id: interrupted.id });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === interrupted.id)?.status).toBe(
      "action_required",
    );
    expect(broker.releaseRunner).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
  }
});

test("releases local capacity when registration never created a cloud lease", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    broker.reconcileRunner.mockResolvedValue({
      id: "fence",
      bindingId: "binding",
      environmentId: "test",
      phase: "released",
    });
    const operation = service.submit("recover", { type: "runner.reconcile", id: interrupted.id });
    await service.drain();
    expect(store.get("operation", operation.id)).toMatchObject({ status: "succeeded" });
    expect(store.get("operation", interrupted.id)).toMatchObject({ status: "cancelled" });
    expect(service.snapshot().runnerCapacity?.active).toBe(0);
    expect(broker.prepareRunner).not.toHaveBeenCalled();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
  }
});

test("cloud access failure leaves a stopped runner unresolved", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    broker.reconcileRunner.mockRejectedValue(new Error("Cloud connection unavailable"));
    service.submit("recover", { type: "runner.reconcile", id: interrupted.id });
    await service.drain();
    expect(store.get("operation", interrupted.id)).toMatchObject({ status: "action_required" });
    expect(service.snapshot().runnerCapacity?.active).toBe(0);
    expect(broker.releaseRunner).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
  }
});

test.each(["stopped", "absent", "interrupted"] as const)(
  "restart automatically reconciles a %s runner VM before releasing capacity",
  async (state) => {
    const { store, service, broker, interrupted, runtime } = await fixture();
    await service.close();
    store.update(interrupted, { status: "running" });
    if (state === "absent") store.remove("instance", "instance");
    else
      store.put("instance", "instance", {
        id: "instance",
        environmentId: "test",
        status: state,
        pid: state === "stopped" ? 0 : 42,
        createdAt: new Date().toISOString(),
      });
    const reconcile = vi.spyOn(runtime, "reconcile").mockResolvedValue(true);
    const restarted = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
      connected: () => true,
    });
    try {
      expect(store.get("operation", interrupted.id)).toMatchObject({
        status: "action_required",
        result: { code: "runner_recovery_pending" },
      });
      await restarted.initialize();
      await restarted.drain();
      expect(store.get("operation", interrupted.id)).toMatchObject({
        status: "cancelled",
        result: { code: "runner_interrupted", stage: "finished" },
      });
      expect(broker.reconcileRunner).toHaveBeenCalledOnce();
      expect(broker.releaseRunner).toHaveBeenCalledOnce();
      expect(broker.prepareRunner).not.toHaveBeenCalled();
      expect(restarted.snapshot().runnerCapacity?.active).toBe(0);
      if (state === "interrupted") expect(reconcile).toHaveBeenCalledWith("instance", undefined);
    } finally {
      await restarted.close();
      store.close();
    }
  },
);

test("restart never settles a runner whose VM might still be running", async () => {
  const { store, service, broker, interrupted, runtime } = await fixture();
  await service.close();
  store.update(interrupted, { status: "running" });
  store.put("instance", "instance", {
    id: "instance",
    environmentId: "test",
    status: "running",
    pid: 42,
    createdAt: new Date().toISOString(),
  });
  vi.spyOn(runtime, "reconcile").mockResolvedValue(false);
  const restarted = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
    connected: () => true,
  });
  try {
    await restarted.initialize();
    await restarted.drain();
    expect(store.get("instance", "instance")).toMatchObject({ status: "interrupted" });
    expect(store.get("operation", interrupted.id)).toMatchObject({
      status: "action_required",
      result: { code: "runner_recovery_pending" },
    });
    expect(broker.reconcileRunner).not.toHaveBeenCalled();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
    expect(restarted.snapshot().runnerCapacity?.active).toBe(1);
  } finally {
    await restarted.close();
    store.close();
  }
});

test("restart leaves stopped runners pending when cloud release is unconfirmed", async () => {
  const { store, service, broker, interrupted, runtime } = await fixture();
  await service.close();
  store.update(interrupted, { status: "running" });
  broker.releaseRunner.mockRejectedValue(new Error("GitHub unavailable"));
  const restarted = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
    connected: () => true,
  });
  try {
    await restarted.initialize();
    await restarted.drain();
    expect(store.get("operation", interrupted.id)).toMatchObject({
      status: "action_required",
      result: { code: "runner_recovery_pending", recovery: { attempts: 1 } },
    });
    expect(restarted.snapshot().runnerCapacity?.active).toBe(1);
  } finally {
    await restarted.close();
    store.close();
  }
});

test("restart closes a request interrupted before startup without registering a runner", async () => {
  const { store, service, broker, runtime } = await fixture();
  await service.close();
  const request = store.accept(
    "not-started",
    "fingerprint",
    "runner.run",
    activityFor("not-started", { type: "runner.run", bindingId: "binding" }),
    "not-started",
  ).operation;
  const restarted = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
    connected: () => true,
  });
  try {
    await restarted.initialize();
    await restarted.drain();
    expect(store.get("operation", request.id)).toMatchObject({
      status: "failed",
      result: { code: "runner_interrupted" },
    });
    expect(broker.prepareRunner).not.toHaveBeenCalled();
  } finally {
    await restarted.close();
    store.close();
  }
});
