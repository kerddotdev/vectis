import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { MigrationPublication } from "../../../packages/protocol/src/migrations.js";

test("uncertain publication remains actionable and does not block or duplicate machine commands", async () => {
  const store = new Store(":memory:");
  const publishMigration = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<MigrationPublication>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("lost response")), { once: true });
      }),
  );
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }), () => ({
    publishMigration,
    analyzeMigration: async () => {
      throw new Error("unused");
    },
    scanJobs: async () => ({ runs: 0, jobs: 0, complete: true }),
    refreshJob: async () => ({ jobId: 1, labels: [], status: "queued", conclusion: null }),
    repositories: async () => [],
    connectRepository: async () => "binding",
    disconnectRepository: async () => {},
    setAutomatic: async () => {},
    findRunner: async () => null,
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    releaseRunner: async () => {},
  }));
  try {
    const command = { type: "migration.publish" as const, previewId: "preview" };
    const op = service.submit("publish", command);
    await service.drain();
    expect(service.submit("publish", command).id).toBe(op.id);
    service.submit("pause", { type: "machine.pause", paused: true });
    await service.drain();
    expect(store.snapshot().machine.paused).toBe(true);
    service.submit("cancel", { type: "operation.cancel", id: op.id });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === op.id)?.status).toBe(
        "action_required",
      ),
    );
    expect(publishMigration).toHaveBeenCalledOnce();
  } finally {
    await service.close();
    store.close();
  }
});
