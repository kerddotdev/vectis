import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Environment, Instance } from "../../../packages/protocol/src/index.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/runner/src/guest.js")>()),
  executeGuest: vi.fn(),
}));
vi.mock("./resource-probe.js", () => ({
  resourceProbe: () => ({ footprintsMiB: new Map(), pressure: "normal", pressureKnown: true }),
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const ok = { exitCode: 0, stdout: "", stderr: "", truncated: false };

async function fixture(
  options: {
    native?: boolean;
    recover?: Instance;
    reconciled?: boolean;
    pendingStart?: boolean;
    cache?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "vectis-service-warm-"));
  const store = new Store(join(home, "state.sqlite"));
  const basePath = join(home, "base.img");
  await writeFile(basePath, "isolated test image");
  const helper = join(home, "helper");
  await writeFile(
    helper,
    `#!${process.execPath}\nprocess.stdout.write('{"event":"vm.running"}\\n'); setInterval(() => {}, 1000);`,
    { mode: 0o700 },
  );
  const environment: Environment = {
    id: "linux",
    name: "Linux",
    os: "linux",
    state: "ready",
    cpu: 1,
    memoryMiB: 512,
    basePath,
    warmPool: options.recover ? 0 : 1,
  };
  store.put("environment", environment.id, environment);
  store.put("machine", "self", {
    id: "self",
    name: "Test",
    paused: false,
    maxRunners: 2,
    memoryBudgetMiB: 2048,
  });
  if (options.recover) store.put("instance", options.recover.id, options.recover);
  const exits = new Map<string, (cleaned: boolean) => void>();
  const runtime = new VmRuntime({ home, appleHelper: helper });
  const start = vi.spyOn(runtime, "start");
  const stop = vi.spyOn(runtime, "stop");
  if (!options.native) {
    start.mockImplementation(async (id, env, onExit, signal) => {
      signal?.throwIfAborted();
      if (options.pendingStart) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal?.throwIfAborted();
      }
      exits.set(id, onExit);
      return {
        id,
        process: new ChildProcess(),
        directory: runtime.directoryFor(id, env),
        settled: Promise.resolve(),
      };
    });
    stop.mockImplementation(async (id) => {
      exits.get(id)?.(true);
      exits.delete(id);
    });
    vi.spyOn(runtime, "close").mockImplementation(async () => {
      for (const id of exits.keys()) await runtime.stop(id);
    });
  }
  const reconcile = vi.spyOn(runtime, "reconcile").mockResolvedValue(options.reconciled ?? true);
  const broker = {
    repositories: vi.fn(async () => [
      {
        id: "binding",
        environmentId: "linux",
        installationId: 1,
        repositoryId: 1,
        repositoryName: "test/repo",
        ...(options.cache ? { cacheVolume: { enabled: true, sizeGiB: 1 } } : {}),
      },
    ]),
    prepareRunner: vi.fn(async () => ({
      state: "ready" as const,
      cacheWrite: false,
      id: "lease",
      runnerId: 1,
      environmentId: "linux",
      os: "linux" as const,
      encodedConfig: "c2VjcmV0",
      access: { repositoryId: 1, actors: "any" as const, approval: "automatic" as const },
    })),
    releaseRunner: vi.fn(async () => {}),
    reconcileRunner: vi.fn(async () => {
      throw new Error("unused");
    }),
    runnerStatus: vi.fn(async () => ({ busy: false, status: "online" as const })),
    analyzeMigration: async () => {
      throw new Error("unused");
    },
    publishMigration: async () => {
      throw new Error("unused");
    },
    connectRepository: async () => "binding",
    disconnectRepository: async () => {},
    setAutomatic: async () => {},
    setAccess: async () => {},
    jobLogs: async () => {
      throw new Error("unused");
    },
    scanJobs: async () => ({ runs: 0, jobs: 0, complete: true }),
    refreshJob: async () => {
      throw new Error("unused");
    },
    controlRun: async () => {
      throw new Error("unused");
    },
  };
  const service = new Service(store, runtime, () => broker);
  cleanups.push(async () => {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  vi.mocked(readyGuest).mockResolvedValue({
    host: "192.0.2.1",
    port: 22,
    user: "test",
    identityFile: join(home, "key"),
    knownHostsFile: join(home, "hosts"),
    hostKeyAlias: "test",
  });
  vi.mocked(executeGuest).mockResolvedValue(ok);
  await service.initialize();
  const warm = () =>
    store.snapshot().instances.filter((item) => item.role === "warm" && item.status === "running");
  const listening = () =>
    vi.mocked(executeGuest).mockImplementationOnce(async (_connection, _script, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      throw new GuestUnavailableError("cancelled test listener");
    });
  return { home, store, runtime, service, broker, start, stop, reconcile, warm, listening };
}

test("runner takeover skips boot and readiness, then cancellation stops the claimed VM", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  const id = f.warm()[0]!.id;
  vi.mocked(executeGuest).mockResolvedValueOnce(ok).mockResolvedValueOnce(ok);
  f.listening();
  const run = f.service.submit("takeover", { type: "runner.run", bindingId: "binding" });
  await vi.waitFor(() => expect(f.broker.prepareRunner).toHaveBeenCalledOnce());
  expect(f.start).toHaveBeenCalledOnce();
  expect(readyGuest).toHaveBeenCalledOnce();
  expect(f.store.snapshot().operations.find((op) => op.id === run.id)?.result).toMatchObject({
    instanceId: id,
    stage: "listening",
  });
  expect(f.store.snapshot().instances.find((item) => item.id === id)?.role).toBeUndefined();
  f.service.submit("cancel", { type: "operation.cancel", id: run.id });
  await vi.waitFor(() => expect(f.broker.releaseRunner).toHaveBeenCalledOnce());
  expect(f.stop).toHaveBeenCalledWith(id);
});

test("unhealthy warm SSH stops that VM before cold startup and JIT registration", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  const warmId = f.warm()[0]!.id;
  vi.mocked(executeGuest)
    .mockRejectedValueOnce(new GuestUnavailableError("stale SSH"))
    .mockResolvedValueOnce(ok);
  f.listening();
  f.start.mockImplementationOnce(async (id, env, onExit) => {
    expect(f.stop).toHaveBeenCalledWith(warmId);
    expect(f.broker.prepareRunner).not.toHaveBeenCalled();
    const child = new ChildProcess();
    f.stop.mockImplementation(async (stoppedId) => {
      if (stoppedId === id) onExit(true);
    });
    return {
      id,
      process: child,
      directory: f.runtime.directoryFor(id, env),
      settled: Promise.resolve(),
    };
  });
  const run = f.service.submit("fallback", { type: "runner.run", bindingId: "binding" });
  await vi.waitFor(() => expect(f.broker.prepareRunner).toHaveBeenCalledOnce());
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(readyGuest).toHaveBeenCalledTimes(2);
  const start = f.store.snapshot().operations.find((op) => op.key === `${run.id}:start`);
  expect(f.store.snapshot().operations.find((op) => op.id === run.id)?.result).toMatchObject({
    instanceId: start?.id,
  });
});

test("configure zero and pause drain the pool through the shared service contract", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  const disabled = f.service.submit("disable", {
    type: "environment.configure",
    id: "linux",
    warmPool: 0,
  });
  await f.service.drain();
  expect(f.store.snapshot().operations.find((op) => op.id === disabled.id)?.status).toBe(
    "succeeded",
  );
  expect(f.warm()).toHaveLength(0);
  expect(f.store.snapshot().environments[0]?.warmPool).toBe(0);
  f.service.submit("enable", { type: "environment.configure", id: "linux", warmPool: 1 });
  await f.service.drain();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  f.service.submit("pause", { type: "machine.pause", paused: true });
  await f.service.drain();
  expect(f.warm()).toHaveLength(0);
});

test("pool disabling remains available while image preparation is busy", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  f.store.put("windowsInstallation", "synthetic-preparation", { phase: "installing" });
  const operation = f.service.submit("disable-busy", {
    type: "environment.configure",
    id: "linux",
    warmPool: 0,
  });
  await f.service.drain();
  expect(f.store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
    "succeeded",
  );
  expect(f.warm()).toHaveLength(0);
  expect(f.store.snapshot().environments[0]?.warmPool).toBe(0);
});

test("a timed-out warm startup aborts and awaits its owned task", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture({ pendingStart: true });
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  const signal = f.start.mock.calls[0]?.[3];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(f.store.snapshot().instances.every((item) => item.status === "stopped")).toBe(true);
  expect(readyGuest).not.toHaveBeenCalled();
});

test.each([false, true])(
  "restart reconciles interrupted warm VMs, confirmed stopped: %s",
  async (reconciled) => {
    const instance: Instance = {
      id: "old-warm",
      environmentId: "linux",
      status: "running",
      role: "warm",
      memoryMiB: 512,
      pid: 123,
      directory: "/synthetic/old",
      createdAt: new Date().toISOString(),
    };
    const f = await fixture({ recover: instance, reconciled });
    expect(f.reconcile).toHaveBeenCalledWith(instance.id, instance.directory);
    expect(f.store.snapshot().instances[0]?.status).toBe(reconciled ? "stopped" : "interrupted");
    expect(f.warm()).toHaveLength(0);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "the pool starts and cleans a fake executable through the existing VM lifecycle",
  async () => {
    const f = await fixture({ native: true });
    await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
    const id = f.warm()[0]!.id;
    expect(f.warm()[0]?.pid).toBeGreaterThan(0);
    await f.service.close();
    expect(f.stop).toHaveBeenCalledWith(id);
    expect(f.store.snapshot().instances.find((item) => item.id === id)?.status).toBe("stopped");
  },
);

test("a cache runner boots with its private disk while a generic warm VM remains unclaimed", async () => {
  const f = await fixture({ cache: true });
  await vi.waitFor(() => expect(f.warm()).toHaveLength(1));
  const warmId = f.warm()[0]!.id;
  vi.mocked(executeGuest).mockResolvedValueOnce(ok);
  f.listening();
  const run = f.service.submit("cache-cold", { type: "runner.run", bindingId: "binding" });
  await vi.waitFor(() => expect(f.broker.prepareRunner).toHaveBeenCalledOnce());
  expect(f.start).toHaveBeenCalledTimes(2);
  const coldId = f.start.mock.calls[1]?.[0];
  expect(coldId).not.toBe(warmId);
  expect(f.start.mock.calls[1]?.[4]).toMatchObject({
    sourcePath: join(f.home, "instances", "cache", "linux", "1-1", "cache.img"),
  });
  expect(f.store.operation(run.id).result).toMatchObject({
    instanceId: coldId,
    stage: "listening",
  });
  expect(f.warm().map((instance) => instance.id)).toEqual([warmId]);
  f.service.submit("cancel-cache", { type: "operation.cancel", id: run.id });
  await vi.waitFor(() => expect(f.broker.releaseRunner).toHaveBeenCalledOnce());
  expect(f.stop).toHaveBeenCalledWith(coldId);
  expect(f.stop).not.toHaveBeenCalledWith(warmId);
  expect(f.store.list("cacheUse")).toEqual([]);
});
