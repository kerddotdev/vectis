import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { JobRefresh } from "../../../packages/protocol/src/jobs.js";

test("job refresh does not block machine control and retries reuse its durable operation", async () => {
  const store = new Store(":memory:");
  const refreshJob = vi.fn(
    (_bindingId: string, _jobId: number, signal: AbortSignal) =>
      new Promise<JobRefresh>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }), () => ({
    refreshJob,
    connectRepository: async () => "binding",
    setAutomatic: async () => {},
    repositories: async () => [],
    findRunner: async () => null,
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    releaseRunner: async () => {},
  }));
  try {
    const command = { type: "job.refresh" as const, bindingId: "binding", jobId: 4 };
    const operation = service.submit("refresh", command);
    await service.drain();
    expect(service.submit("refresh", command).id).toBe(operation.id);
    expect(refreshJob).toHaveBeenCalledOnce();
    service.submit("pause", { type: "machine.pause", paused: true });
    await service.drain();
    expect(store.snapshot().machine.paused).toBe(true);
    service.submit("cancel", { type: "operation.cancel", id: operation.id });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "cancelled",
      ),
    );
  } finally {
    await service.close();
    store.close();
  }
});

test("disabling automatic admission cancels a queued demand before guest startup or API access", async () => {
  const store = new Store(":memory:");
  const refreshJob = vi.fn(async () => ({
    jobId: 4,
    status: "queued" as const,
    conclusion: null,
    labels: ["vectis-mac"],
  }));
  const runtime = new VmRuntime({ home: "/unused-isolated-home" });
  const start = vi.spyOn(runtime, "start");
  const service = new Service(store, runtime, () => ({
    refreshJob,
    connectRepository: async () => "binding",
    setAutomatic: async () => {},
    repositories: async () => [
      {
        id: "binding",
        repositoryId: 1,
        repositoryName: "test/repo",
        environmentId: "mac",
        automatic: false,
      },
    ],
    findRunner: async () => null,
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    releaseRunner: async () => {},
  }));
  store.put("environment", "mac", {
    id: "mac",
    name: "Mac",
    os: "macos",
    state: "ready",
    cpu: 2,
    memoryMiB: 4096,
    basePath: "/unused/base",
  });
  try {
    const operation = service.submit("automatic", {
      type: "runner.run",
      bindingId: "binding",
      jobId: 4,
      automatic: true,
    });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "cancelled",
      ),
    );
    expect(refreshJob).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
    start.mockRestore();
  }
});
