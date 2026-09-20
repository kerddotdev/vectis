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
    setAutomatic: vi.fn(async () => {}),
    analyzeMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    publishMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    scanJobs: vi.fn(async () => ({ runs: 0, jobs: 0, complete: true })),
    refreshJob: vi.fn(async () => ({
      jobId: 1,
      labels: [],
      status: "completed" as const,
      conclusion: "success",
    })),
    findRunner: vi.fn<RunnerBroker["findRunner"]>(async () => ({
      id: "lease",
      bindingId: "binding",
      environmentId: "test",
      phase: "ready",
    })),
    prepareRunner: vi.fn<RunnerBroker["prepareRunner"]>(),
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
  return { store, service, broker, interrupted };
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
    expect(broker.findRunner).not.toHaveBeenCalled();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
  }
});
test("rejects a mismatched cloud lease and leaves the original operation unresolved", async () => {
  const { store, service, broker, interrupted } = await fixture();
  try {
    broker.findRunner.mockResolvedValue({
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
