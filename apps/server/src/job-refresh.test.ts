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
