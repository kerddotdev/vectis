import { expect, test } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { LinuxPreparation } from "../../../packages/protocol/src/index.js";
const configuration: LinuxPreparation = {
  id: "linux",
  name: "Linux",
  imageDirectory: "/isolated/images",
  storagePath: "/isolated/vms",
  cpu: 2,
  memoryMiB: 2048,
  diskGiB: 32,
};
test("preparation cannot overlap an existing VM reservation", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }));
  store.put("instance", "running", {
    id: "running",
    environmentId: "other",
    directory: "/isolated/instance",
    cpu: 2,
    memoryMiB: 2048,
    status: "running",
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  try {
    const op = service.submit("prepare", { type: "environment.prepare-linux", ...configuration });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === op.id)?.result).toMatchObject({
      code: "preparation_busy",
    });
    expect(store.list("preparation")).toHaveLength(0);
  } finally {
    await service.close();
    store.close();
  }
});
test("resuming completed preparation cannot overwrite registered settings", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }));
  store.put("preparation", "setup", { id: "setup", configuration, phase: "prepared" });
  store.put("environment", "linux", {
    id: "linux",
    name: "Changed",
    os: "linux",
    basePath: "/isolated/base",
    cpu: 4,
    memoryMiB: 8192,
    state: "ready",
  });
  try {
    const op = service.submit("resume", { type: "environment.resume", id: "setup" });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === op.id)?.result).toMatchObject({
      code: "preparation_complete",
    });
    expect(store.snapshot().environments[0]?.cpu).toBe(4);
  } finally {
    await service.close();
    store.close();
  }
});
