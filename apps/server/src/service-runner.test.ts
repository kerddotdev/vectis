import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VectisError } from "../../../packages/protocol/src/index.js";
import type { RunnerBroker, RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { activityFor } from "./activities.js";
import type { JobRefresh } from "../../../packages/protocol/src/jobs.js";
import { Service } from "./service.js";
import { runnerCapacity } from "./runner-capacity.js";
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
  ["listening", "idle drain"],
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
      setAccess: async () => {},
      setAutomatic: vi.fn(async () => {}),
      analyzeMigration: vi.fn(async () => {
        throw new Error("unused");
      }),
      publishMigration: vi.fn(async () => {
        throw new Error("unused");
      }),
      jobLogs: async () => {
        throw new Error("Unexpected job log read.");
      },
      scanJobs: vi.fn(async () => ({ runs: 0, jobs: 0, complete: true })),
      controlRun: async () => {
        throw new Error("unused");
      },
      refreshJob: vi.fn(async (): Promise<JobRefresh> => ({
        jobId: 1,
        runId: 2,
        name: "Build",
        workflowName: "CI",
        htmlUrl: "https://github.com/test/repo/actions/runs/2/job/1",
        runnerId: 0,
        runnerName: null,
        updatedAt: 1,
        labels: ["vectis-test"],
        status: "queued" as const,
        conclusion: null,
      })),
      reconcileRunner: vi.fn(async () => {
        throw new Error("unused");
      }),
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
        access: { repositoryId: 2, actors: "any" as const, approval: "automatic" as const },
      })),
      runnerStatus: async () => ({ busy: false, status: "online" as const }),
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
      if (cancelType === "idle drain")
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const run = service.submit("run", { type: "runner.run", bindingId: "binding", jobId: 1 });
      if (validation) await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
      else await vi.waitFor(() => expect(broker.prepareRunner).toHaveBeenCalledOnce());
      const replay = service.submit("run", { type: "runner.run", bindingId: "binding", jobId: 1 });
      expect(replay.id).toBe(run.id);
      service.submit("pause", { type: "machine.pause", paused: true });
      await service.drain();
      expect(store.snapshot().machine.paused).toBe(true);
      expect(store.snapshot().instances[0]?.status).toBe(
        phase === "starting" ? "starting" : "running",
      );
      if (cancelType === "idle drain") {
        broker.refreshJob.mockImplementation(async () => ({
          jobId: 1,
          runId: 2,
          name: "Build",
          workflowName: "CI",
          htmlUrl: "https://github.com/test/repo/actions/runs/2/job/1",
          runnerId: 99,
          runnerName: "another-runner",
          updatedAt: 2,
          labels: ["vectis-test"],
          status: "queued",
          conclusion: null,
        }));
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        vi.useRealTimers();
      } else service.submit("cancel", { type: cancelType, id: run.id });
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
      expect(snapshot.operations.find((item) => item.id === run.id)?.result).toMatchObject({
        phases: expect.arrayContaining([
          expect.objectContaining({
            name: "queued_locally",
            startedAt: run.createdAt,
            endedAt: expect.any(String),
          }),
          expect.objectContaining({ name: "vm_start", endedAt: expect.any(String) }),
          expect.objectContaining({ name: "cleanup", endedAt: expect.any(String) }),
        ]),
      });
      expect(snapshot.activities).toHaveLength(1);
      expect(snapshot.activities?.[0]?.subject).not.toHaveProperty("actualJob");
      expect(snapshot.activities?.[0]).toMatchObject({
        id: run.id,
        kind: "github",
        status: "cancelled",
        bindingId: "binding",
        environmentId: "test",
        repository: { id: 1, name: "test/repo" },
        subject: {
          type: "runner",
          requestedJob: {
            jobId: 1,
            runId: 2,
            name: "Build",
            workflowName: "CI",
            htmlUrl: "https://github.com/test/repo/actions/runs/2/job/1",
            status: "queued",
            conclusion: null,
          },
        },
      });
      if (cancelType === "idle drain") {
        expect(runnerCapacity(snapshot, { cpus: 8, memoryBytes: 16 * 1024 ** 3 }).active).toBe(0);
        expect(snapshot.operations.find((item) => item.id === run.id)).toMatchObject({
          status: "cancelled",
          result: { code: "runner_idle" },
        });
        expect(snapshot.operations.find((item) => item.id === run.id)?.result).not.toHaveProperty(
          "nextStep",
        );
      }
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
      vi.useRealTimers();
      vi.resetAllMocks();
    }
  },
);

test.each(["rosetta_not_installed", "rosetta_unsupported", "rosetta_guest_unprepared"])(
  "parent runner operation preserves %s from its instance startup",
  async (code) => {
    const { VectisError } = await import("../../../packages/protocol/src/index.js");
    const home = await mkdtemp(join(tmpdir(), "vectis-rosetta-runner-"));
    const store = new Store(":memory:");
    const runtime = new VmRuntime({ home });
    const unused = async () => {
      throw new Error("Unexpected broker call");
    };
    const broker = {
      reconcileRunner: vi.fn(unused),
      prepareRunner: vi.fn(unused),
      releaseRunner: vi.fn(async () => {}),
      runnerStatus: vi.fn(unused),
      jobLogs: unused,
      controlRun: async () => {
        throw new Error("unused");
      },
      repositories: async () => [
        { id: "binding", repositoryId: 1, repositoryName: "test/repo", environmentId: "linux" },
      ],
      analyzeMigration: unused,
      publishMigration: unused,
      connectRepository: unused,
      disconnectRepository: unused,
      setAutomatic: unused,
      setAccess: unused,
      scanJobs: unused,
      refreshJob: unused,
    };
    const service = new Service(store, runtime, () => broker);
    vi.spyOn(runtime, "start").mockRejectedValue(
      new VectisError(code, "Rosetta needs setup.", "Fix Rosetta setup."),
    );
    store.put("environment", "linux", {
      id: "linux",
      name: "Linux",
      os: "linux",
      state: "ready",
      cpu: 1,
      memoryMiB: 512,
      basePath: join(home, "synthetic.img"),
      x64: "rosetta",
    });
    try {
      const operation = service.submit("runner", { type: "runner.run", bindingId: "binding" });
      await service.drain();
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
          status: "action_required",
          result: { code, nextStep: "Fix Rosetta setup." },
        }),
      );
      expect(broker.prepareRunner).not.toHaveBeenCalled();
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

async function cleanupFixture(intervalMs = 60000) {
  const home = await mkdtemp(join(tmpdir(), "vectis-runner-cleanup-"));
  const store = new Store(join(home, "state.sqlite"));
  const runtime = new VmRuntime({ home });
  const unused = async () => {
    throw new Error("Unexpected broker call");
  };
  const broker = {
    reconcileRunner: vi.fn<RunnerBroker["reconcileRunner"]>(async () => ({
      id: "lease",
      bindingId: "binding",
      environmentId: "test",
      phase: "ready",
    })),
    releaseRunner: vi.fn<RunnerBroker["releaseRunner"]>(async () => {}),
    prepareRunner: unused,
    runnerStatus: unused,
    jobLogs: unused,
    controlRun: unused,
    repositories: unused,
    analyzeMigration: unused,
    publishMigration: unused,
    connectRepository: unused,
    disconnectRepository: unused,
    setAutomatic: unused,
    setAccess: unused,
    scanJobs: unused,
    refreshJob: unused,
  };
  vi.spyOn(runtime, "reconcile").mockResolvedValue(false);
  const cloud = { connected: true };
  const service = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
    intervalMs,
    connected: () => cloud.connected,
  });
  const progress: RunnerProgress = {
    bindingId: "binding",
    environmentId: "test",
    leaseKey: "run",
    leaseId: "lease",
    instanceId: "instance",
    stage: "cleaning",
  };
  const accepted = store.accept(
    "run",
    "fingerprint",
    "runner.run",
    activityFor("run", { type: "runner.run", bindingId: "binding" }),
    "run",
  );
  const operation = store.update(accepted.operation, {
    status: "action_required",
    message: "Waiting for runner cleanup.",
    result: { ...progress, code: "runner_cleanup_required" },
  });
  const instance = {
    id: "instance",
    environmentId: "test",
    status: "stopped" as const,
    pid: 0,
    createdAt: new Date().toISOString(),
  };
  store.put("instance", instance.id, instance);
  await service.initialize();
  return {
    store,
    service,
    runtime,
    broker,
    cloud,
    operation,
    progress,
    instance,
    read: () => store.snapshot().operations.find((item) => item.id === operation.id),
    tick: async (ms = 60000) => {
      await vi.advanceTimersByTimeAsync(ms);
      await service.drain();
    },
    close: async () => {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("automatic runner cleanup", () => {
  let fixture: Awaited<ReturnType<typeof cleanupFixture>>;
  beforeEach(async () => {
    vi.useFakeTimers();
    fixture = await cleanupFixture();
  });
  afterEach(async () => {
    await fixture.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("busy cleanup retries the existing operation and activity until GitHub releases it", async () => {
    const { broker, read, tick, store, operation } = fixture;
    broker.releaseRunner.mockRejectedValueOnce(new VectisError("runner_busy", "Runner is busy."));
    await tick();
    expect(read()).toMatchObject({
      status: "action_required",
      result: { code: "runner_cleanup_required" },
    });
    await tick();
    expect(read()).toMatchObject({
      status: "cancelled",
      result: { stage: "finished", leaseId: "lease" },
    });
    expect(broker.releaseRunner).toHaveBeenCalledTimes(2);
    expect(store.snapshot().operations).toHaveLength(1);
    expect(store.snapshot().activities).toMatchObject([{ id: operation.id, status: "cancelled" }]);
    await tick();
    expect(broker.releaseRunner).toHaveBeenCalledTimes(2);
  });

  test("cleanup retries back off from one minute to thirty minutes", async () => {
    const { broker, tick, read } = fixture;
    broker.releaseRunner.mockRejectedValue(new Error("GitHub unavailable"));
    for (const [attempt, minutes] of [1, 1, 2, 4, 8, 16, 30, 30].entries()) {
      await tick(minutes * 60000 - 1);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(attempt);
      await tick(1);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(attempt + 1);
      expect(read()).toMatchObject({
        status: "action_required",
        result: {
          recovery: {
            attempts: attempt + 1,
            nextAttemptAt: Date.now() + Math.min(60000 * 2 ** attempt, 30 * 60000),
          },
        },
      });
    }
  });

  test("cleanup preserves retry scheduling across service restarts", async () => {
    const { broker, tick, service, store, runtime } = fixture;
    broker.releaseRunner.mockRejectedValue(new Error("GitHub unavailable"));
    await tick(2 * 60000);
    await service.close();
    const restarted = new Service(store, runtime, () => broker, undefined, undefined, undefined, {
      connected: () => true,
    });
    try {
      await restarted.initialize();
      await restarted.drain();
      expect(broker.releaseRunner).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2 * 60000 - 1);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await restarted.drain();
      expect(broker.releaseRunner).toHaveBeenCalledTimes(3);
    } finally {
      await restarted.close();
    }
  });

  test.each([new VectisError("runner_busy", "Runner is busy."), new Error("GitHub unavailable")])(
    "failed cleanup backs off and stops retrying after 24 hours without claiming success: %s",
    async (error) => {
      const { broker, tick, read, operation } = fixture;
      broker.releaseRunner.mockRejectedValue(error);
      await tick(29 * 60000);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(5);
      expect(read()).toMatchObject({
        status: "action_required",
        result: { code: "runner_cleanup_required" },
      });
      await tick(24 * 60 * 60000);
      const attempts = broker.releaseRunner.mock.calls.length;
      expect(read()).toMatchObject({
        status: "action_required",
        message: expect.stringContaining("expired after 24 hours"),
        result: { nextStep: expect.stringContaining("runner reconcile") },
      });
      await tick(60 * 60000);
      expect(broker.releaseRunner).toHaveBeenCalledTimes(attempts);
      expect(read()).toMatchObject({
        status: "action_required",
        result: { code: "runner_cleanup_required" },
      });
      broker.releaseRunner.mockResolvedValue();
      fixture.service.submit("manual", { type: "runner.reconcile", id: operation.id });
      await fixture.service.drain();
      expect(read()?.status).toBe("cancelled");
    },
  );

  test.each(["manual", "automatic"])(
    "%s cleanup preserves an assignment refusal as failure",
    async (mode) => {
      const { store, operation, progress, service, tick, read } = fixture;
      const cause = {
        code: "runner_assignment_rejected" as const,
        message: "Vectis refused an unapproved job.",
      };
      store.update(operation, { result: { ...progress, code: "runner_cleanup_required", cause } });
      if (mode === "manual") {
        service.submit("manual", { type: "runner.reconcile", id: operation.id });
        await service.drain();
      } else await tick();
      expect(read()).toMatchObject({
        status: "failed",
        message: cause.message,
        result: { stage: "finished", code: cause.code, cause },
      });
      expect(store.snapshot().activities).toMatchObject([
        { status: "failed", message: cause.message },
      ]);
    },
  );

  test("offline recovery ends as retryable failure after delayed cleanup", async () => {
    fixture.store.update(fixture.operation, {
      result: {
        ...fixture.progress,
        code: "runner_cleanup_required",
        recoveryCause: { code: "runner_offline", message: "Runner went offline." },
      },
    });
    await fixture.tick();
    expect(fixture.read()).toMatchObject({
      status: "failed",
      message: "Runner went offline.",
      result: { code: "runner_offline" },
    });
  });

  test("legacy interrupted runner results without a code also recover automatically", async () => {
    fixture.store.update(fixture.operation, { result: fixture.progress });
    await fixture.tick();
    expect(fixture.read()).toMatchObject({
      status: "cancelled",
      result: { code: "runner_interrupted" },
    });
  });

  test("approval requirements remain actionable until manually reconciled", async () => {
    fixture.store.update(fixture.operation, {
      result: { ...fixture.progress, code: "public_runner_approval_required" },
    });
    await fixture.tick();
    expect(fixture.read()?.status).toBe("action_required");
    expect(fixture.broker.reconcileRunner).not.toHaveBeenCalled();
  });

  test("disconnected cleanup waits for the cloud connection", async () => {
    fixture.cloud.connected = false;
    await fixture.tick();
    expect(fixture.broker.reconcileRunner).not.toHaveBeenCalled();
    fixture.cloud.connected = true;
    await fixture.tick();
    expect(fixture.read()?.status).toBe("cancelled");
  });

  test.each(["starting", "running", "interrupted"] as const)(
    "a %s VM prevents GitHub cleanup",
    async (status) => {
      fixture.store.put("instance", fixture.instance.id, { ...fixture.instance, status, pid: 42 });
      await fixture.tick();
      expect(fixture.broker.reconcileRunner).not.toHaveBeenCalled();
      expect(fixture.read()).toMatchObject({
        status: "action_required",
        result: { code: "runner_cleanup_required" },
      });
    },
  );

  test("registration uncertainty is automatically reconciled after VM cleanup", async () => {
    fixture.store.update(fixture.operation, {
      result: { ...fixture.progress, code: "runner_registration_uncertain" },
    });
    await fixture.tick();
    expect(fixture.broker.reconcileRunner).toHaveBeenCalledOnce();
    expect(fixture.read()?.status).toBe("cancelled");
  });

  test("a mismatched lease is never released or reported cleaned up", async () => {
    fixture.broker.reconcileRunner.mockResolvedValue({
      id: "other",
      bindingId: "binding",
      environmentId: "test",
      phase: "ready",
    });
    await fixture.tick();
    expect(fixture.broker.releaseRunner).not.toHaveBeenCalled();
    expect(fixture.read()).toMatchObject({
      status: "action_required",
      result: { code: "runner_cleanup_required" },
    });
  });

  test("close clears the timer and aborts an in-flight cleanup without completing it", async () => {
    fixture.broker.releaseRunner.mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.broker.releaseRunner).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.broker.releaseRunner).toHaveBeenCalledOnce();
    fixture.service.submit("pause", { type: "machine.pause", paused: true });
    fixture.service.submit("manual", { type: "runner.reconcile", id: fixture.operation.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.snapshot().machine.paused).toBe(true);
    expect(
      fixture.store.snapshot().operations.find((operation) => operation.key === "manual"),
    ).toMatchObject({ status: "action_required", result: { code: "reconciliation_required" } });
    expect(fixture.broker.reconcileRunner).toHaveBeenCalledOnce();
    expect(() => fixture.service.beginShutdown(true)).toThrow("The service still has active work");
    await fixture.service.close();
    expect(fixture.read()).toMatchObject({
      status: "action_required",
      result: { code: "runner_cleanup_required" },
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.broker.releaseRunner).toHaveBeenCalledOnce();
  });
});

test("the cleanup interval is injectable and repeated initialization owns one timer", async () => {
  vi.useFakeTimers();
  const fixture = await cleanupFixture(1000);
  try {
    const timerCount = vi.getTimerCount();
    await fixture.service.initialize();
    expect(vi.getTimerCount()).toBe(timerCount);
    await fixture.tick(999);
    expect(fixture.broker.releaseRunner).not.toHaveBeenCalled();
    await fixture.tick(1);
    expect(fixture.read()?.status).toBe("cancelled");
    expect(fixture.broker.releaseRunner).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

test("a slow instance stop does not block other submissions and duplicate stops share cleanup", async () => {
  const fixture = await cleanupFixture();
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = vi.spyOn(fixture.runtime, "stop").mockImplementation(async () => {
    await waiting;
  });
  fixture.store.put("instance", "slow", {
    id: "slow",
    environmentId: "test",
    status: "running",
    pid: 42,
    createdAt: new Date().toISOString(),
  });
  try {
    const first = fixture.service.submit("stop", { type: "instance.stop", id: "slow" });
    expect(fixture.service.submit("stop", { type: "instance.stop", id: "slow" }).id).toBe(first.id);
    const second = fixture.service.submit("another-stop", { type: "instance.stop", id: "slow" });
    const pause = fixture.service.submit("pause", { type: "machine.pause", paused: true });
    await fixture.service.drain();
    expect(fixture.store.get("operation", pause.id)).toMatchObject({ status: "succeeded" });
    expect(fixture.store.get("operation", first.id)).toMatchObject({ status: "running" });
    expect(stop).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() =>
      expect(fixture.store.get("operation", second.id)).toMatchObject({ status: "succeeded" }),
    );
    expect(fixture.store.get("operation", first.id)).toMatchObject({ status: "succeeded" });
  } finally {
    finish();
    await fixture.close();
    vi.restoreAllMocks();
  }
});

test("a stop waits for its own startup cleanup while other commands advance", async () => {
  const fixture = await cleanupFixture();
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  vi.spyOn(fixture.runtime, "start").mockImplementation(
    async (_id, _environment, _exited, signal) => {
      signal?.addEventListener("abort", () => events.push("start-aborted"), { once: true });
      await waiting;
      events.push("start-settled");
      throw new Error("Cancelled startup");
    },
  );
  vi.spyOn(fixture.runtime, "hasWorkDirectory").mockResolvedValue(true);
  vi.spyOn(fixture.runtime, "stop").mockImplementation(async () => {
    events.push("stop");
  });
  fixture.store.put("environment", "test", {
    id: "test",
    name: "Test",
    os: "linux",
    state: "ready",
    basePath: "/test/base",
    cpu: 1,
    memoryMiB: 512,
  });
  try {
    const start = fixture.service.submit("start", { type: "environment.start", id: "test" });
    const stop = fixture.service.submit("stop-start", { type: "instance.stop", id: start.id });
    const pause = fixture.service.submit("pause", { type: "machine.pause", paused: true });
    await fixture.service.drain();
    expect(fixture.store.get("operation", pause.id)).toMatchObject({ status: "succeeded" });
    expect(events).toEqual(["start-aborted"]);
    finish();
    await vi.waitFor(() =>
      expect(fixture.store.get("operation", stop.id)).toMatchObject({ status: "succeeded" }),
    );
    expect(events).toEqual(["start-aborted", "start-settled", "stop"]);
  } finally {
    finish();
    await fixture.close();
    vi.restoreAllMocks();
  }
});

test("a runner repository lookup does not hold the command queue", async () => {
  const fixture = await cleanupFixture();
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(fixture.broker, "repositories").mockImplementation(async () => {
    await waiting;
    throw new VectisError("repository_access_unavailable", "Unavailable");
  });
  try {
    const runner = fixture.service.submit("lookup", { type: "runner.run", bindingId: "binding" });
    const pause = fixture.service.submit("pause", { type: "machine.pause", paused: true });
    await fixture.service.drain();
    expect(fixture.store.get("operation", runner.id)).toMatchObject({ status: "running" });
    expect(fixture.store.get("operation", pause.id)).toMatchObject({ status: "succeeded" });
    finish();
    await vi.waitFor(() =>
      expect(fixture.store.get("operation", runner.id)).toMatchObject({
        status: "failed",
        result: { code: "repository_access_unavailable" },
      }),
    );
  } finally {
    finish();
    await fixture.close();
    vi.restoreAllMocks();
  }
});
