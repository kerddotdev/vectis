import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

test("pending image access allows pause and cancellation without admitting another VM", async () => {
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
    expect(service.submit("start", { type: "environment.start", id: "test" }).id).toBe(start.id);
    const second = service.submit("second", { type: "environment.start", id: "test" });
    const reconcile = service.submit("reconcile", { type: "instance.reconcile", id: start.id });
    service.submit("pause", { type: "machine.pause", paused: true });
    service.submit("cancel", { type: "operation.cancel", id: start.id });
    await service.drain();
    const snapshot = store.snapshot();
    expect(snapshot.machine.paused).toBe(true);
    expect(snapshot.operations.find((item) => item.id === second.id)).toMatchObject({
      status: "action_required",
      result: { code: "reconciliation_required" },
    });
    expect(snapshot.operations.find((item) => item.id === start.id)?.status).toBe("running");
    expect(snapshot.operations.find((item) => item.id === reconcile.id)?.result).toMatchObject({
      code: "instance_starting",
    });
    expect(snapshot.instances).toHaveLength(1);
    release();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === start.id)?.status).toBe(
        "cancelled",
      ),
    );
    expect(store.snapshot().instances[0]).toMatchObject({ status: "stopped", pid: 0 });
    expect(await runtime.hasWorkDirectory(start.id)).toBe(false);
    expect(validation).toHaveBeenCalledOnce();
  } finally {
    release();
    await service.close();
    validation.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
