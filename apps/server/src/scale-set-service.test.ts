import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { MachineRepositories } from "../../../packages/protocol/src/repositories.js";
import type { ScaleSetGrant } from "../../../packages/protocol/src/scale-sets.js";
import { runRunnerTask } from "./runner-task.js";
vi.mock("./runner-task.js", () => ({ runRunnerTask: vi.fn() }));

test("the service owns the listener lifecycle, exposes its state and submits scale set runners without demand checks", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-scale-set-service-"));
  const store = new Store(join(home, "state.sqlite"));
  let bindings: MachineRepositories = [
    {
      id: "binding",
      repositoryId: 1,
      repositoryName: "owner/repo",
      environmentId: "linux",
      automatic: true,
      capacityMode: "demand",
    },
  ];
  const unused = async () => {
    throw new Error("Unexpected broker call.");
  };
  const grant: ScaleSetGrant = {
    bindingId: "binding",
    generation: 3,
    scaleSetId: 42,
    scaleSetName: "vectis-linux",
    sessionId: "00000000-0000-4000-8000-000000000001",
    messageQueueUrl: "https://queue.test/messages",
    messageQueueAccessToken: "queue-canary",
  };
  const broker = {
    repositories: async () => bindings,
    prepareRunner: vi.fn(unused),
    reconcileRunner: unused,
    releaseRunner: unused,
    runnerStatus: unused,
    connectRepository: unused,
    disconnectRepository: unused,
    setAutomatic: unused,
    setAccess: unused,
    controlRun: unused,
    analyzeMigration: unused,
    publishMigration: unused,
    scanJobs: unused,
    refreshJob: vi.fn(unused),
    jobLogs: unused,
    setCapacityMode: vi.fn(async (_bindingId: string, mode: "demand" | "scale_set") => {
      bindings = bindings.map((binding) => ({ ...binding, capacityMode: mode }));
      store.touch();
    }),
    openScaleSet: vi.fn(async () => grant),
    refreshScaleSet: unused,
    closeScaleSet: vi.fn(async () => {}),
  };
  const fetch = vi.fn(
    async (_url: URL, input: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const service = new Service(
    store,
    new VmRuntime({ home }),
    () => broker,
    undefined,
    () => bindings,
    undefined,
    { connected: () => true },
  );
  const environment = {
    id: "linux",
    name: "Linux",
    os: "linux" as const,
    state: "ready" as const,
    cpu: 1,
    memoryMiB: 512,
    basePath: join(home, "synthetic.img"),
  };
  store.put("environment", environment.id, environment);
  vi.mocked(runRunnerTask).mockImplementation(async (_bindingId, _key, _environment) => ({
    status: "succeeded",
    message: "Synthetic lifecycle completed.",
    progress: { bindingId: "binding", environmentId: "linux", leaseKey: "key", stage: "finished" },
  }));
  try {
    await service.initialize();
    expect(broker.openScaleSet).not.toHaveBeenCalled();
    service.submit("mode", {
      type: "repository.capacity-mode",
      bindingId: "binding",
      mode: "scale_set",
    });
    await service.drain();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(service.snapshot().scaleSets).toMatchObject([
      { bindingId: "binding", state: "listening", scaleSetName: "vectis-linux" },
    ]);
    expect(JSON.stringify(service.snapshot())).not.toContain("queue-canary");
    service.submit("scale-runner", {
      type: "runner.run",
      bindingId: "binding",
      automatic: true,
      scaleSet: { generation: 3 },
    });
    await service.drain();
    await vi.waitFor(() => expect(runRunnerTask).toHaveBeenCalledOnce());
    const controls = vi.mocked(runRunnerTask).mock.calls[0]?.[3];
    expect(controls?.request).toEqual({ automatic: true, scaleSet: { generation: 3 } });
    expect(controls?.needed).toBeUndefined();
    expect(broker.refreshJob).not.toHaveBeenCalled();
    service.submit("pause", { type: "machine.pause", paused: true });
    await service.drain();
    await vi.waitFor(() =>
      expect(broker.closeScaleSet).toHaveBeenCalledExactlyOnceWith(
        "binding",
        3,
        expect.any(AbortSignal),
      ),
    );
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(service.snapshot().scaleSets).toMatchObject([
      { bindingId: "binding", state: "stopped" },
    ]);
  } finally {
    await service.close();
    store.close();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    await rm(home, { recursive: true, force: true });
  }
});
