import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest } from "../../../packages/runner/src/guest.js";
vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", () => ({ executeGuest: vi.fn() }));

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "a listening runner does not block pause, cancellation or ordered VM cleanup",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "vectis-runner-task-"));
    const store = new Store(":memory:");
    const helper = join(home, "helper");
    await writeFile(
      helper,
      `#!${process.execPath}\nprocess.stdout.write('{"event":"vm.running"}\\n'); setInterval(() => {}, 1000);`,
      { mode: 0o700 },
    );
    const basePath = join(home, "base.img");
    await writeFile(basePath, "isolated test image");
    const broker = {
      connectRepository: vi.fn(async () => "binding"),
      setAutomatic: vi.fn(async () => {}),
      analyzeMigration: vi.fn(async () => {
        throw new Error("unused");
      }),
      publishMigration: vi.fn(async () => {
        throw new Error("unused");
      }),
      scanJobs: vi.fn(async () => ({ runs: 0, jobs: 0, complete: true })),
      refreshJob: vi.fn(async () => ({
        jobId: 1,
        labels: [],
        status: "completed" as const,
        conclusion: "success",
      })),
      findRunner: vi.fn(async () => null),
      repositories: async () => [
        { id: "binding", environmentId: "test", repositoryId: 1, repositoryName: "test/repo" },
      ],
      prepareRunner: vi.fn(async () => ({
        state: "ready" as const,
        id: "lease",
        runnerId: 1,
        environmentId: "test",
        os: "linux" as const,
        encodedConfig: "c2VjcmV0",
      })),
      releaseRunner: vi.fn(async () => {
        expect(store.snapshot().instances.every((instance) => instance.status === "stopped")).toBe(
          true,
        );
      }),
    };
    const service = new Service(store, new VmRuntime({ home, appleHelper: helper }), () => broker);
    vi.mocked(readyGuest).mockResolvedValue({
      host: "192.168.64.2",
      port: 22,
      user: "vectis",
      identityFile: "/test/key",
      knownHostsFile: "/test/hosts",
      hostKeyAlias: "test",
    });
    vi.mocked(executeGuest).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    });
    vi.mocked(executeGuest).mockImplementationOnce(async (_connection, _script, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      throw new Error("cancelled");
    });
    try {
      service.submit("register", {
        type: "environment.register",
        environment: {
          id: "test",
          name: "Test",
          os: "linux",
          state: "ready",
          cpu: 1,
          memoryMiB: 512,
          basePath,
        },
      });
      await service.drain();
      const run = service.submit("run", { type: "runner.run", bindingId: "binding" });
      await vi.waitFor(() => expect(broker.prepareRunner).toHaveBeenCalledOnce());
      const replay = service.submit("run", { type: "runner.run", bindingId: "binding" });
      expect(replay.id).toBe(run.id);
      service.submit("pause", { type: "machine.pause", paused: true });
      await service.drain();
      expect(store.snapshot().machine.paused).toBe(true);
      expect(store.snapshot().instances[0]?.status).toBe("running");
      service.submit("cancel", { type: "operation.cancel", id: run.id });
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === run.id)?.status).toBe(
          "cancelled",
        ),
      );
      expect(broker.releaseRunner).toHaveBeenCalledOnce();
      expect(store.snapshot().instances).toHaveLength(1);
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
      vi.resetAllMocks();
    }
  },
);
