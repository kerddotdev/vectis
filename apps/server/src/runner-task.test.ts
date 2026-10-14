import { afterEach, expect, test, vi } from "vitest";
import { runRunnerTask } from "./runner-task.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { collectRunnerDiagnostics } from "../../../packages/runner/src/guest-diagnostics.js";
import { VectisError, type Environment } from "../../../packages/protocol/src/index.js";
vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/runner/src/guest.js")>()),
  executeGuest: vi.fn(),
}));
vi.mock("../../../packages/runner/src/guest-diagnostics.js", () => ({
  collectRunnerDiagnostics: vi.fn(async () => "collected"),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
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
function fixture(os: Environment["os"] = "linux") {
  const events: string[] = [];
  const broker = {
    findRunner: vi.fn(async () => null),
    prepareRunner: vi.fn(async () => ({
      state: "ready" as const,
      id: "lease",
      runnerId: 12,
      encodedConfig: "c2VjcmV0",
      access: { repositoryId: 2, actors: "any" as const, approval: "automatic" as const },
      environmentId: "test",
      os,
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
test("a failed pinned guest identity never allocates JIT credentials or sends runner scripts", async () => {
  const { controls, broker } = fixture();
  vi.mocked(readyGuest).mockRejectedValue(
    new GuestUnavailableError("Host key verification failed"),
  );
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ status: "failed", code: "guest_unavailable" });
  expect(broker.prepareRunner).not.toHaveBeenCalled();
  expect(executeGuest).not.toHaveBeenCalled();
  expect(controls.stop).toHaveBeenCalledOnce();
});
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
test.each(["public_runner_approval_required", "private_runner_approval_required"])(
  "%s stops the owned VM and retains actionable policy guidance",
  async (code) => {
    const { controls, broker } = fixture();
    broker.prepareRunner.mockRejectedValue(
      new VectisError(code, "Approval is required.", "Change the GitHub fork approval policy."),
    );
    const result = await runRunnerTask(
      "binding",
      "key",
      environment,
      controls,
      AbortSignal.timeout(1000),
    );
    expect(result).toMatchObject({
      status: "action_required",
      code,
      message: "Approval is required.",
      nextStep: expect.stringContaining("Change the GitHub fork approval policy."),
    });
    expect(controls.stop).toHaveBeenCalledOnce();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
    expect(executeGuest).toHaveBeenCalledTimes(1);
  },
);
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

test.each([0, 1])(
  "a refused assignment is failed even when the listener exits %s",
  async (exitCode) => {
    const { controls, events } = fixture();
    vi.mocked(executeGuest)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
      .mockResolvedValueOnce({
        exitCode,
        stdout: "VECTIS_RUNNER_ASSIGNMENT_REJECTED\n",
        stderr: "",
        truncated: false,
      });
    const result = await runRunnerTask(
      "binding",
      "key",
      environment,
      controls,
      AbortSignal.timeout(1000),
    );
    expect(result).toMatchObject({ status: "failed", code: "runner_assignment_rejected" });
    expect(events).toEqual(["stop", "release"]);
  },
);

function heldListener() {
  const state: { signal?: AbortSignal; finish?: () => void } = {};
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockImplementationOnce(async (_connection, _script, options) => {
      state.signal = options.signal;
      return new Promise((resolve, reject) => {
        const cancel = () => reject(new VectisError("guest_cancelled", "Listening aborted."));
        options.signal.addEventListener("abort", cancel, { once: true });
        state.finish = () => {
          options.signal.removeEventListener("abort", cancel);
          resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
        };
      });
    });
  return state;
}

test.each(["linux", "macos", "windows"] as const)(
  "%s marker backstop aborts listening and stops the VM before releasing the runner",
  async (os) => {
    vi.useFakeTimers();
    const { controls, events } = fixture(os);
    const state = heldListener();
    vi.mocked(executeGuest).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "VECTIS_RUNNER_ASSIGNMENT_REJECTED\nactor not allowed\n",
      stderr: "",
      truncated: false,
    });
    const result = runRunnerTask(
      "binding",
      "key",
      { ...environment, os },
      controls,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(executeGuest).toHaveBeenCalledTimes(2);
    expect(state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      status: "failed",
      code: "runner_assignment_rejected",
      message: "Vectis refused the assigned GitHub job: actor not allowed.",
    });
    expect(state.signal?.aborted).toBe(true);
    expect(events).toEqual(["stop", "release"]);
    expect(executeGuest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining("assignment-rejected"),
      expect.objectContaining({ shell: os === "windows" ? "powershell" : "bash" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(collectRunnerDiagnostics).not.toHaveBeenCalled();
  },
);

test("transient marker check errors leave listening active and the next check can reject", async () => {
  vi.useFakeTimers();
  const { controls, events } = fixture();
  const state = heldListener();
  vi.mocked(executeGuest)
    .mockRejectedValueOnce(new GuestUnavailableError("SSH connection reset"))
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: "VECTIS_RUNNER_ASSIGNMENT_REJECTED\nrepository id mismatch\n",
      stderr: "",
      truncated: false,
    });
  const result = runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(state.signal?.aborted).toBe(false);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(10000);
  await expect(result).resolves.toMatchObject({
    status: "failed",
    code: "runner_assignment_rejected",
    message: expect.stringContaining("repository id mismatch"),
  });
  expect(events).toEqual(["stop", "release"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a listener that exits before the first poll still reads the rejection reason", async () => {
  const { controls, events } = fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "", truncated: false })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: "VECTIS_RUNNER_ASSIGNMENT_REJECTED\nrun approval mismatch\n",
      stderr: "",
      truncated: false,
    });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({
    status: "failed",
    code: "runner_assignment_rejected",
    message: expect.stringContaining("run approval mismatch"),
  });
  expect(events).toEqual(["stop", "release"]);
});

test("cancellation stops an in-flight marker check and releases all monitoring timers", async () => {
  vi.useFakeTimers();
  const { controls, events } = fixture();
  heldListener();
  let probeSignal: AbortSignal | undefined;
  vi.mocked(executeGuest).mockImplementationOnce(async (_connection, _script, options) => {
    probeSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new GuestUnavailableError("SSH aborted")),
        { once: true },
      );
    });
  });
  const abort = new AbortController();
  const result = runRunnerTask("binding", "key", environment, controls, abort.signal);
  await vi.advanceTimersByTimeAsync(19000);
  expect(executeGuest).toHaveBeenCalledTimes(3);
  expect(probeSignal?.aborted).toBe(false);
  abort.abort();
  await expect(result).resolves.toMatchObject({ status: "cancelled" });
  expect(probeSignal?.aborted).toBe(true);
  expect(events).toEqual(["stop", "release"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a witnessed policy rejection stays failed if cancellation arrives during cleanup", async () => {
  const { controls } = fixture();
  const abort = new AbortController();
  controls.stop.mockImplementation(async () => {
    abort.abort();
  });
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: "VECTIS_RUNNER_ASSIGNMENT_REJECTED\nactor not allowed\n",
      stderr: "",
      truncated: false,
    });
  const result = await runRunnerTask("binding", "key", environment, controls, abort.signal);
  expect(result).toMatchObject({ status: "failed", code: "runner_assignment_rejected" });
});

test.each(["rosetta_not_installed", "rosetta_unsupported", "rosetta_guest_unprepared"])(
  "runner startup preserves actionable %s without allocating credentials",
  async (code) => {
    const { controls, broker } = fixture();
    controls.start.mockRejectedValue(
      new VectisError(code, "Rosetta needs setup.", "Fix Rosetta setup."),
    );
    const result = await runRunnerTask(
      "binding",
      "key",
      { ...environment, x64: "rosetta" },
      controls,
      AbortSignal.timeout(1000),
    );
    expect(result).toMatchObject({
      status: "action_required",
      code,
      nextStep: "Fix Rosetta setup.",
    });
    expect(broker.prepareRunner).not.toHaveBeenCalled();
    expect(controls.stop).toHaveBeenCalledOnce();
  },
);
