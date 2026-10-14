import { afterEach, expect, test, vi } from "vitest";
import type { RunnerBroker } from "../../../packages/protocol/src/runners.js";
import { VectisError } from "../../../packages/protocol/src/index.js";
import { runRunnerTask } from "./runner-task.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { collectRunnerDiagnostics } from "../../../packages/runner/src/guest-diagnostics.js";
vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/runner/src/guest.js")>()),
  executeGuest: vi.fn(),
}));
vi.mock("../../../packages/runner/src/guest-diagnostics.js", () => ({
  collectRunnerDiagnostics: vi.fn(async () => "collected"),
}));
const listeningTasks: Array<{ abort: AbortController; done: Promise<unknown> }> = [];
afterEach(async () => {
  for (const task of listeningTasks) task.abort.abort();
  await Promise.all(listeningTasks.map((task) => task.done));
  listeningTasks.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const environment = {
  id: "test",
  name: "Test",
  os: "linux" as const,
  state: "ready" as const,
  basePath: "/test/base",
  cpu: 1,
  memoryMiB: 512,
};
function fixture() {
  const events: string[] = [];
  const broker = {
    reconcileRunner: vi.fn(async () => {
      throw new Error("unused");
    }),
    prepareRunner: vi.fn(async () => ({
      state: "ready" as const,
      id: "lease",
      runnerId: 12,
      encodedConfig: "c2VjcmV0",
      environmentId: "test",
      os: "linux" as const,
    })),
    runnerStatus: vi.fn<RunnerBroker["runnerStatus"]>(async () => ({
      busy: false,
      status: "online",
    })),
    releaseRunner: vi.fn(async () => {
      events.push("release");
    }),
  };
  const controls = {
    broker,
    start: vi.fn(async () => ({
      id: "instance",
      environmentId: "test",
      status: "running" as const,
      pid: 1,
      createdAt: new Date().toISOString(),
    })),
    stop: vi.fn(async () => {
      events.push("stop");
    }),
    progress: vi.fn(),
  };
  vi.mocked(readyGuest).mockResolvedValue({
    host: "192.168.64.2",
    port: 22,
    user: "vectis",
    identityFile: "/test/key",
    knownHostsFile: "/test/hosts",
    hostKeyAlias: "test",
  });
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  });
  return { controls, broker, events };
}
test("stops the VM before removing registration and never persists JIT configuration", async () => {
  const { controls, events } = fixture();
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result.status).toBe("succeeded");
  expect(events).toEqual(["stop", "release"]);
  expect(JSON.stringify(controls.progress.mock.calls)).not.toContain("c2VjcmV0");
  expect(result.message).toContain("Check GitHub");
});
test("retains registration if VM termination is unconfirmed", async () => {
  const { controls, broker } = fixture();
  controls.stop.mockRejectedValue(new Error("exit unknown"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result.status).toBe("action_required");
  expect(broker.releaseRunner).not.toHaveBeenCalled();
});
test("a lost registration response requires reconciliation instead of a fresh retry", async () => {
  const { controls, broker } = fixture();
  broker.prepareRunner.mockRejectedValue(new Error("disconnected"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({
    status: "action_required",
    code: "runner_registration_uncertain",
  });
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(broker.prepareRunner).toHaveBeenCalledOnce();
});
test("cancellation during VM startup still waits for owned cleanup and never registers", async () => {
  const { controls, broker } = fixture();
  const abort = new AbortController();
  controls.start.mockImplementation(async () => {
    abort.abort();
    return { id: "instance", environmentId: "test", status: "running", pid: 1, createdAt: "now" };
  });
  const result = await runRunnerTask("binding", "key", environment, controls, abort.signal);
  expect(result.status).toBe("cancelled");
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(broker.prepareRunner).not.toHaveBeenCalled();
});

test("completed demand does not boot a VM or register another runner", async () => {
  const { controls, broker } = fixture();
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      needed: async () => false,
    },
    AbortSignal.timeout(1000),
  );
  expect(result.status).toBe("cancelled");
  expect(controls.start).not.toHaveBeenCalled();
  expect(controls.stop).not.toHaveBeenCalled();
  expect(broker.prepareRunner).not.toHaveBeenCalled();
});
test("demand that disappears during preparation cleans its VM without registration", async () => {
  const { controls, broker } = fixture();
  const needed = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      needed,
    },
    AbortSignal.timeout(1000),
  );
  expect(result.status).toBe("cancelled");
  expect(controls.start).toHaveBeenCalledOnce();
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(broker.prepareRunner).not.toHaveBeenCalled();
});

test("a runner that loses its guest connection keeps diagnostics gathered before the VM stops", async () => {
  const { controls, events } = fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockRejectedValueOnce(new GuestUnavailableError("exit 255: Connection timed out"));
  vi.mocked(collectRunnerDiagnostics).mockImplementation(async () => {
    events.push("diagnose");
    return "collected";
  });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ status: "failed", code: "guest_unavailable" });
  expect(result.progress.diagnostics).toBe("collected");
  expect(events).toEqual(["diagnose", "stop", "release"]);
  expect(collectRunnerDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      listener: "connection lost: exit 255: Connection timed out",
      secrets: ["c2VjcmV0"],
    }),
  );
});

test("a runner process that exits unsuccessfully reports its output", async () => {
  const { controls } = fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValueOnce({ exitCode: 1, stdout: "no network", stderr: "", truncated: false });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ status: "failed", code: "runner_process_failed" });
  expect(collectRunnerDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ listener: expect.stringContaining("no network") }),
  );
});

test("successful and cancelled runners gather no diagnostics", async () => {
  const { controls } = fixture();
  await runRunnerTask("binding", "key", environment, controls, AbortSignal.timeout(1000));
  const abort = new AbortController();
  controls.start.mockImplementation(async () => {
    abort.abort();
    return { id: "instance", environmentId: "test", status: "running", pid: 1, createdAt: "now" };
  });
  await runRunnerTask("binding", "key", environment, controls, abort.signal);
  expect(collectRunnerDiagnostics).not.toHaveBeenCalled();
});

async function listeningFixture(withJob = true) {
  vi.useFakeTimers();
  const { controls, broker, events } = fixture();
  const abort = new AbortController();
  const needed = vi.fn(async (_signal: AbortSignal) => true);
  let complete = () => {};
  vi.mocked(executeGuest)
    .mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }))
    .mockImplementationOnce(async (_connection, _script, { signal }) => {
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(new VectisError("guest_cancelled", "Guest cancelled."));
        complete = () => {
          signal.removeEventListener("abort", cancelled);
          resolve();
        };
        signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted) cancelled();
      });
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    });
  const done = runRunnerTask(
    "binding",
    "key",
    environment,
    { ...controls, ...(withJob ? { needed } : {}) },
    abort.signal,
  );
  listeningTasks.push({ abort, done });
  await vi.advanceTimersByTimeAsync(0);
  expect(controls.progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ stage: "listening" }),
  );
  return { controls, broker, events, abort, needed, done, complete };
}

test.each([
  { busy: false, status: "online" as const },
  { busy: false, status: "offline" as const },
  { missing: true as const },
])(
  "an idle runner with status %j drains only after ten minutes and releases capacity",
  async (status) => {
    const { broker, events, needed, done } = await listeningFixture();
    broker.runnerStatus.mockResolvedValue(status);
    needed.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(events).toEqual([]);
    expect(needed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toMatchObject({
      status: "cancelled",
      code: "runner_idle",
      progress: { stage: "finished" },
    });
    expect(events).toEqual(["stop", "release"]);
    expect(broker.releaseRunner).toHaveBeenCalledWith("lease", expect.any(AbortSignal));
    expect(collectRunnerDiagnostics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a busy runner keeps its VM even after the requested job no longer needs capacity", async () => {
  const { broker, events, needed, done, complete } = await listeningFixture();
  needed.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(events).toEqual([]);
  expect(needed).toHaveBeenCalledTimes(2);
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
  expect(events).toEqual(["stop", "release"]);
});

test("the idle window restarts after the runner was busy", async () => {
  const { broker, events, needed, done } = await listeningFixture();
  needed.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
  await vi.advanceTimersByTimeAsync(30000);
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await done).toMatchObject({ status: "cancelled", code: "runner_idle" });
});

test("an idle runner whose requested job still needs queued capacity keeps listening", async () => {
  const { events, needed, done, complete } = await listeningFixture();
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(needed.mock.calls.length).toBeGreaterThan(2);
  expect(events).toEqual([]);
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
});

test.each(["status", "job"] as const)(
  "%s lookup errors keep listening and require a fresh idle window",
  async (lookup) => {
    const { broker, events, needed, done } = await listeningFixture();
    if (lookup === "status") {
      broker.runnerStatus.mockRejectedValue(new Error("GitHub unavailable"));
      needed.mockResolvedValue(false);
    } else needed.mockRejectedValue(new Error("Job unknown"));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(events).toEqual([]);
    broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
    needed.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toMatchObject({ status: "cancelled", code: "runner_idle" });
  },
);

test("a job assigned during the demand read prevents drain", async () => {
  const { broker, events, needed, done, complete } = await listeningFixture();
  needed.mockImplementation(async () => {
    broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
    return false;
  });
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(events).toEqual([]);
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
});

test.each(["stop", "release"] as const)(
  "idle drain with failed %s cleanup needs reconciliation",
  async (step) => {
    const { controls, broker, needed, done } = await listeningFixture();
    needed.mockResolvedValue(false);
    if (step === "stop") controls.stop.mockRejectedValue(new Error("VM exit unknown"));
    else broker.releaseRunner.mockRejectedValue(new Error("Registration unknown"));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await done).toMatchObject({
      status: "action_required",
      code: "runner_cleanup_required",
    });
    if (step === "stop") expect(broker.releaseRunner).not.toHaveBeenCalled();
  },
);

test("cancellation interrupts an in-flight status read and releases its watcher", async () => {
  const { broker, abort, done } = await listeningFixture();
  broker.runnerStatus.mockImplementation(
    (_id, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  await vi.advanceTimersByTimeAsync(30000);
  abort.abort();
  expect(await done).toMatchObject({ status: "cancelled" });
  expect(vi.getTimerCount()).toBe(0);
});

test("the six-hour listening timeout still cleans up without reporting idle drain", async () => {
  const timeout = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 6 * 60 * 60 * 1000 ? timeout.signal : originalTimeout(ms),
  );
  const { done, events } = await listeningFixture();
  timeout.abort(new DOMException("Timed out", "TimeoutError"));
  expect(await done).toMatchObject({ status: "failed", code: "guest_cancelled" });
  expect(events).toEqual(["stop", "release"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a manual runner without a requested job keeps listening beyond the idle window", async () => {
  const { broker, events, done, complete } = await listeningFixture(false);
  await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  expect(events).toEqual([]);
  expect(broker.runnerStatus).not.toHaveBeenCalled();
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
});
