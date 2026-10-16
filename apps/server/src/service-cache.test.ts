import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { CacheVolumes } from "../../../packages/runner/src/cache-volume.js";
import type { MachineRepositories } from "../../../packages/protocol/src/repositories.js";
import { executeGuest } from "../../../packages/runner/src/guest.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";

vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", async (original) => ({
  ...(await original<typeof import("../../../packages/runner/src/guest.js")>()),
  executeGuest: vi.fn(),
}));
vi.mock("../../../packages/runner/src/memory.js", async (original) => ({
  ...(await original<typeof import("../../../packages/runner/src/memory.js")>()),
  availableHostMemory: async () => 8 * 1024 ** 3,
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.resetAllMocks();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-service-cache-"));
  const store = new Store(join(home, "state.sqlite"));
  const helper = join(home, "helper");
  await writeFile(
    helper,
    `#!${process.execPath}\nprocess.stdout.write('{"event":"vm.running"}\\n'); setInterval(() => {}, 1000);`,
    { mode: 0o700 },
  );
  const basePath = join(home, "base.img");
  await writeFile(basePath, "boot");
  const environment = {
    id: "linux",
    name: "Linux",
    os: "linux",
    state: "ready",
    basePath,
    cpu: 1,
    memoryMiB: 512,
  } as const;
  store.put("environment", environment.id, environment);
  const binding = {
    id: "binding",
    installationId: 1,
    repositoryId: 2,
    repositoryName: "owner/repo",
    environmentId: "linux",
    cacheVolume: { enabled: true, sizeGiB: 1 },
  };
  let repositories: MachineRepositories = [binding];
  let cloudSnapshot: MachineRepositories | undefined;
  const unused = async () => {
    throw new Error("Unexpected broker call");
  };
  const broker = {
    repositories: vi.fn(async () => repositories),
    disconnectRepository: vi.fn(async () => {
      repositories = [];
    }),
    setCacheVolume: vi.fn(async (_id: string, settings: { enabled: boolean; sizeGiB?: number }) => {
      binding.cacheVolume = {
        enabled: settings.enabled,
        sizeGiB: settings.sizeGiB ?? binding.cacheVolume.sizeGiB,
      };
    }),
    setAccess: unused,
    setAutomatic: unused,
    analyzeMigration: unused,
    publishMigration: unused,
    connectRepository: unused,
    jobLogs: unused,
    scanJobs: unused,
    refreshJob: unused,
    controlRun: unused,
    reconcileRunner: unused,
    prepareRunner: vi.fn(
      async () =>
        ({
          state: "ready",
          id: "lease",
          runnerId: 3,
          encodedConfig: "c2VjcmV0",
          environmentId: "linux",
          os: "linux",
          cacheWrite: true,
          access: {
            repositoryId: 2,
            actors: "any",
            approval: "automatic",
            cacheRun: { runId: 5, runAttempt: 1 },
          },
        }) as const,
    ),
    releaseRunner: vi.fn(async () => {}),
    runnerStatus: unused,
  };
  const runtime = new VmRuntime({ home, appleHelper: helper });
  const service = new Service(
    store,
    runtime,
    () => broker,
    undefined,
    () => cloudSnapshot,
  );
  cleanups.push(async () => {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const cacheDirectory = new CacheVolumes(home).directory(environment, binding);
  vi.mocked(readyGuest).mockResolvedValue({
    host: "192.168.64.2",
    port: 22,
    user: "vectis",
    identityFile: "/fake/key",
    knownHostsFile: "/fake/hosts",
    hostKeyAlias: "test",
  });
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  });
  return {
    home,
    service,
    store,
    broker,
    binding,
    runtime,
    cacheDirectory,
    setSnapshot: (value: MachineRepositories | undefined) => {
      cloudSnapshot = value;
    },
  };
}

test("cache settings use the cloud binding and clear deletes generations", async () => {
  const { service, broker, cacheDirectory } = await fixture();
  const enabled = service.submit("enable", {
    type: "repository.cache",
    bindingId: "binding",
    enabled: true,
    sizeGiB: 2,
  });
  await service.drain();
  expect(broker.setCacheVolume).toHaveBeenCalledWith("binding", { enabled: true, sizeGiB: 2 });
  expect(service.snapshot().operations.find((item) => item.id === enabled.id)?.status).toBe(
    "succeeded",
  );
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "cache.img"), "cache");
  await writeFile(join(cacheDirectory, "cache.previous.img"), "previous");
  const cleared = service.submit("clear", { type: "cache.clear", bindingId: "binding" });
  await service.drain();
  expect(service.snapshot().operations.find((item) => item.id === cleared.id)?.status).toBe(
    "succeeded",
  );
  await expect(stat(cacheDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("disconnect removes cache disks and retries work after the cloud binding disappears", async () => {
  const { service, broker, cacheDirectory } = await fixture();
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "cache.img"), "cache");
  service.submit("disconnect", { type: "repository.disconnect", bindingId: "binding" });
  await service.drain();
  expect(broker.disconnectRepository).toHaveBeenCalledWith("binding");
  await expect(stat(cacheDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  service.submit("disconnect-retry", { type: "repository.disconnect", bindingId: "binding" });
  await service.drain();
  expect(service.snapshot().operations[0]?.status).toBe("succeeded");
});

test("an authoritative cloud disconnect cleans retained volumes; unknown cloud state preserves them", async () => {
  const { service, cacheDirectory, setSnapshot } = await fixture();
  service.submit("remember", { type: "repository.cache", bindingId: "binding", enabled: false });
  await service.drain();
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "cache.img"), "cache");
  service.repositoriesChanged();
  await service.drain();
  expect(await readFile(join(cacheDirectory, "cache.img"), "utf8")).toBe("cache");
  setSnapshot([]);
  service.repositoriesChanged();
  await service.drain();
  await expect(stat(cacheDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("clear refuses an interrupted cache instance until reconciliation", async () => {
  const { service, store } = await fixture();
  store.put("cacheUse", "interrupted", { bindingId: "binding", instanceId: "interrupted" });
  store.put("instance", "interrupted", {
    id: "interrupted",
    environmentId: "linux",
    status: "interrupted",
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  const clear = service.submit("clear-interrupted", { type: "cache.clear", bindingId: "binding" });
  await service.drain();
  expect(service.snapshot().operations.find((item) => item.id === clear.id)).toMatchObject({
    status: "failed",
    result: { code: "cache_in_use" },
  });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "a running cache fork blocks clear and promotes only after listener, unmount and VM exit",
  async () => {
    const { service, store, cacheDirectory } = await fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listening = false;
    vi.mocked(executeGuest).mockImplementation(async (_connection, script) => {
      if (script.includes("--jitconfig")) {
        const instance = store.snapshot().instances.find((item) => item.status === "running");
        if (!instance?.directory) throw new Error("Missing private instance directory");
        const file = await open(join(instance.directory, "cache.img"), "r+");
        try {
          await file.write("job-cache", 0, "utf8");
        } finally {
          await file.close();
        }
        listening = true;
        await pending;
      }
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    });
    try {
      const run = service.submit("run", { type: "runner.run", bindingId: "binding" });
      await service.drain();
      await vi.waitFor(() => expect(listening).toBe(true));
      const clear = service.submit("clear-running", { type: "cache.clear", bindingId: "binding" });
      await service.drain();
      expect(service.snapshot().operations.find((item) => item.id === clear.id)).toMatchObject({
        status: "failed",
        result: { code: "cache_in_use" },
      });
      release();
      await vi.waitFor(() =>
        expect(service.snapshot().operations.find((item) => item.id === run.id)?.status).toBe(
          "succeeded",
        ),
      );
      expect(store.operation(run.id).result).toMatchObject({
        cache: { attached: true, writeBack: "granted", promoted: true },
      });
      const instance = store.snapshot().instances.find((item) => item.status === "stopped");
      if (!instance?.directory) throw new Error("Missing stopped instance directory");
      await expect(stat(instance.directory)).rejects.toMatchObject({ code: "ENOENT" });
      const file = await open(join(cacheDirectory, "cache.img"), "r");
      const data = Buffer.alloc(9);
      try {
        await file.read(data, 0, 9, 0);
      } finally {
        await file.close();
      }
      expect(data.toString()).toBe("job-cache");
      let reused = "";
      vi.mocked(executeGuest).mockImplementation(async (_connection, script) => {
        if (script.includes("--jitconfig")) {
          const current = store.snapshot().instances.find((item) => item.status === "running");
          if (!current?.directory) throw new Error("Missing second instance directory");
          const fork = await open(join(current.directory, "cache.img"), "r");
          try {
            const data = Buffer.alloc(9);
            await fork.read(data, 0, data.length, 0);
            reused = data.toString();
          } finally {
            await fork.close();
          }
        }
        return { exitCode: 0, stdout: "", stderr: "", truncated: false };
      });
      const second = service.submit("run-again", { type: "runner.run", bindingId: "binding" });
      await vi.waitFor(() => expect(store.operation(second.id).status).toBe("succeeded"));
      expect(reused).toBe("job-cache");
      expect(store.operation(second.id).result).toMatchObject({
        cache: { attached: true, writeBack: "granted", promoted: true },
      });
      expect(store.list("cacheUse")).toEqual([]);
    } finally {
      release();
    }
  },
);

test("cache acquisition leaves commands responsive and cancellation releases the acquired handle", async () => {
  const f = await fixture();
  type Volume = Awaited<ReturnType<CacheVolumes["acquire"]>>;
  let completeAcquisition = (_volume: Volume) => {};
  const pending = new Promise<Volume>((resolve) => {
    completeAcquisition = resolve;
  });
  const handle = {
    directory: f.cacheDirectory,
    authorizeWrite: vi.fn(),
    outcome: () => ({ promoted: false }),
    release: vi.fn(),
    disk: { sourcePath: join(f.cacheDirectory, "cache.img"), stopped: vi.fn(async () => {}) },
  };
  const acquire = vi.spyOn(CacheVolumes.prototype, "acquire").mockReturnValueOnce(pending);
  try {
    const run = f.service.submit("pending-cache", { type: "runner.run", bindingId: "binding" });
    await f.service.drain();
    expect(acquire).toHaveBeenCalledOnce();
    const pause = f.service.submit("pause-pending-cache", { type: "machine.pause", paused: true });
    f.service.submit("cancel-pending-cache", { type: "operation.cancel", id: run.id });
    await f.service.drain();
    expect(f.store.operation(pause.id).status).toBe("succeeded");
    completeAcquisition(handle);
    await vi.waitFor(() => expect(f.store.operation(run.id).status).toBe("cancelled"));
    expect(handle.release).toHaveBeenCalledOnce();
    expect(f.broker.prepareRunner).not.toHaveBeenCalled();
    expect(f.store.snapshot().instances).toEqual([]);
  } finally {
    completeAcquisition(handle);
    acquire.mockRestore();
  }
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "missing guest sudo preserves the cache generation and prevents another VM start",
  async () => {
    const { service, store, broker, cacheDirectory, runtime } = await fixture();
    const environment = store.snapshot().environments[0];
    if (!environment) throw new Error("Missing synthetic environment");
    const acquired = await new CacheVolumes(runtime.options.home).acquire(
      environment,
      { installationId: 1, repositoryId: 2 },
      1,
    );
    acquired.release();
    const generation = await open(join(cacheDirectory, "cache.img"), "r+");
    try {
      await generation.write("saved-cache");
    } finally {
      await generation.close();
    }
    vi.mocked(executeGuest).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: a password is required",
      truncated: false,
    });
    const start = vi.spyOn(runtime, "start");
    try {
      const run = service.submit("no-sudo", { type: "runner.run", bindingId: "binding" });
      await vi.waitFor(() => expect(store.operation(run.id).status).toBe("failed"));
      expect(store.operation(run.id)).toMatchObject({
        message:
          "This environment cannot mount cache volumes: the guest user has no passwordless sudo.",
        result: {
          code: "cache_volume_requires_guest_sudo",
          nextStep:
            "Prepare or provision a new environment with this Vectis version, or disable the repository cache.",
        },
      });
      expect(broker.prepareRunner).not.toHaveBeenCalled();
      expect(store.snapshot().instances.every((instance) => instance.status === "stopped")).toBe(
        true,
      );
      const file = await open(join(cacheDirectory, "cache.img"), "r");
      try {
        const data = Buffer.alloc(11);
        await file.read(data, 0, data.length, 0);
        expect(data.toString()).toBe("saved-cache");
      } finally {
        await file.close();
      }
      await expect(stat(join(cacheDirectory, "cache.previous.img"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const instance = store.snapshot().instances[0];
      if (!instance?.directory) throw new Error("Missing stopped synthetic instance");
      await expect(stat(join(instance.directory, "cache.img"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const retry = service.submit("no-sudo-retry", { type: "runner.run", bindingId: "binding" });
      await vi.waitFor(() => expect(store.operation(retry.id).status).toBe("failed"));
      expect(store.operation(retry.id).result).toMatchObject({
        code: "cache_volume_requires_guest_sudo",
      });
      expect(start).toHaveBeenCalledOnce();
      expect(executeGuest).toHaveBeenCalledOnce();
      service.submit("disable-no-sudo-cache", {
        type: "repository.cache",
        bindingId: "binding",
        enabled: false,
      });
      await service.drain();
      vi.mocked(executeGuest).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      });
      const withoutCache = service.submit("no-sudo-without-cache", {
        type: "runner.run",
        bindingId: "binding",
      });
      await vi.waitFor(() => expect(store.operation(withoutCache.id).status).toBe("succeeded"));
      expect(broker.prepareRunner).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      start.mockRestore();
    }
  },
);
