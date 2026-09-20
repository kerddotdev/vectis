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

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64").each([
  ["starting", "operation.cancel"],
  ["listening", "operation.cancel"],
  ["starting", "activity.cancel"],
  ["listening", "activity.cancel"],
] as const)(
  "a %s runner does not block pause, %s or ordered VM cleanup",
  async (phase, cancelType) => {
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
      disconnectRepository: async () => {},
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
        labels: ["vectis-test"],
        status: "queued" as const,
        conclusion: null,
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
    const runtime = new VmRuntime({ home, appleHelper: helper });
    const service = new Service(store, runtime, () => broker);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
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
      const validation =
        phase === "starting"
          ? vi.spyOn(runtime, "validate").mockImplementationOnce(() => pending)
          : undefined;
      const run = service.submit("run", { type: "runner.run", bindingId: "binding", jobId: 1 });
      if (validation) await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
      else await vi.waitFor(() => expect(broker.prepareRunner).toHaveBeenCalledOnce());
      const replay = service.submit("run", { type: "runner.run", bindingId: "binding", jobId: 1 });
      expect(replay.id).toBe(run.id);
      service.submit("pause", { type: "machine.pause", paused: true });
      await service.drain();
      expect(store.snapshot().machine.paused).toBe(true);
      expect(store.snapshot().instances[0]?.status).toBe(
        phase === "starting" ? "interrupted" : "running",
      );
      service.submit("cancel", { type: cancelType, id: run.id });
      if (phase === "starting") {
        await vi.waitFor(() =>
          expect(
            store
              .snapshot()
              .operations.filter(
                (item) => item.command === "operation.cancel" && item.status === "succeeded",
              ),
          ).toHaveLength(cancelType === "operation.cancel" ? 2 : 1),
        );
        release();
      }
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === run.id)?.status).toBe(
          "cancelled",
        ),
      );
      expect(broker.prepareRunner).toHaveBeenCalledTimes(phase === "starting" ? 0 : 1);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(phase === "starting" ? 0 : 1);
      expect(store.snapshot().instances).toHaveLength(1);
      const snapshot = store.snapshot();
      expect(snapshot.activities).toHaveLength(1);
      expect(snapshot.activities?.[0]).toMatchObject({
        id: run.id,
        kind: "github",
        status: "cancelled",
        bindingId: "binding",
        environmentId: "test",
        repository: { id: 1, name: "test/repo" },
        subject: { type: "runner", requestedJob: { jobId: 1, status: "queued", conclusion: null } },
      });
      expect(snapshot.operations.find((item) => item.key === `${run.id}:start`)?.activityId).toBe(
        run.id,
      );
      if (phase === "listening")
        expect(snapshot.operations.find((item) => item.key === `${run.id}:stop`)?.activityId).toBe(
          run.id,
        );
      else
        expect(
          snapshot.operations.find((item) => item.key === `${run.id}:cancel-start`)?.activityId,
        ).toBe(run.id);
    } finally {
      release();
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
      vi.resetAllMocks();
    }
  },
);
