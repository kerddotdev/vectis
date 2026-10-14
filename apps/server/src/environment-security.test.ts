import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Environment } from "../../../packages/protocol/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

test("legacy Linux runner images require preparation while preserving all environment metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-image-migration-"));
  const store = new Store(":memory:");
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  const legacy: Environment = {
    id: "legacy",
    name: "Legacy",
    os: "linux",
    state: "ready",
    cpu: 1,
    memoryMiB: 512,
    basePath: join(home, "legacy.img"),
    sshUser: "vectis",
    sshKeyPath: join(home, "key"),
    knownHostsPath: join(home, "hosts"),
    seedPath: join(home, "seed.iso"),
  };
  const environments: Environment[] = [
    legacy,
    { ...legacy, id: "prepared", sshHostKeyMode: "instance" },
    { ...legacy, id: "macos", os: "macos" },
    { ...legacy, id: "windows", os: "windows" },
    { ...legacy, id: "unfinished", state: "action_required" },
  ];
  for (const environment of environments) store.put("environment", environment.id, environment);
  try {
    await service.initialize();
    expect(store.get("environment", legacy.id)).toEqual({ ...legacy, state: "action_required" });
    for (const environment of environments.slice(1))
      expect(store.get("environment", environment.id)).toEqual(environment);
    expect(
      service.snapshot().environments.find((environment) => environment.id === legacy.id)?.state,
    ).toBe("action_required");
    vi.spyOn(runtime, "validate").mockResolvedValue();
    const operation = service.submit("register-legacy", {
      type: "environment.register",
      environment: legacy,
    });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
      status: "action_required",
      result: { code: "setup_required" },
    });
    expect(store.get("environment", legacy.id)).toEqual({ ...legacy, state: "action_required" });
  } finally {
    vi.restoreAllMocks();
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
