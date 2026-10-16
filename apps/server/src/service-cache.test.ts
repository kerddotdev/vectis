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
vi.mock("../../../packages/runner/src/memory.js", () => ({
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
      const file = await open(join(cacheDirectory, "cache.img"), "r");
      const data = Buffer.alloc(9);
      try {
        await file.read(data, 0, 9, 0);
      } finally {
        await file.close();
      }
      expect(data.toString()).toBe("job-cache");
      expect(store.list("cacheUse")).toEqual([]);
    } finally {
      release();
    }
  },
);
