import { afterEach, expect, test, vi } from "vitest";
import { RunnerProgress, type RunnerBroker } from "../../../packages/protocol/src/runners.js";
import { Schema } from "effect";
import { runRunnerTask } from "./runner-task.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { collectRunnerDiagnostics } from "../../../packages/runner/src/guest-diagnostics.js";
import { VectisError, type Environment } from "../../../packages/protocol/src/index.js";
import { jobStartedMarker } from "../../../packages/runner/src/runner-access.js";
import {
  cachePrivilegeError,
  cachePrivilegeScript,
} from "../../../packages/runner/src/cache-guest.js";
import {
  preinstalledRunnerDirectory,
  runnerVersion,
} from "../../../packages/runner/src/runner-release.js";

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
    reconcileRunner: vi.fn<RunnerBroker["reconcileRunner"]>(async () => {
      throw new Error("unused");
    }),
    prepareRunner: vi.fn(async () => ({
      state: "ready" as const,
      cacheWrite: false,
      id: "lease",
      runnerId: 12,
      encodedConfig: "c2VjcmV0",
      environmentId: "test",
      access: { repositoryId: 2, actors: "any" as const, approval: "automatic" as const },
      os,
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

test.each(["linux", "macos", "windows"] as const)(
  "%s cache privilege failure stops before installation and registration and discards the fork",
  async (os) => {
    const { controls, broker } = fixture(os);
    const authorizeWrite = vi.fn();
    const checked = vi.fn();
    vi.mocked(executeGuest).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: a password is required",
      truncated: false,
    });
    const result = await runRunnerTask(
      "binding",
      "key",
      { ...environment, os },
      {
        ...controls,
        cache: { sizeGiB: 1, outcome: () => ({ promoted: false }), authorizeWrite, checked },
      },
      new AbortController().signal,
    );
    const error = cachePrivilegeError();
    expect(result).toMatchObject({
      status: "failed",
      code: error.code,
      message: error.message,
      nextStep: error.nextStep,
    });
    expect(executeGuest).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      cachePrivilegeScript(os),
      expect.objectContaining({ shell: os === "windows" ? "powershell" : "bash" }),
    );
    expect(readyGuest).toHaveBeenCalledOnce();
    expect(checked).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.prepareRunner).not.toHaveBeenCalled();
    expect(broker.releaseRunner).not.toHaveBeenCalled();
    expect(broker.reconcileRunner).not.toHaveBeenCalled();
    expect(controls.stop).toHaveBeenCalledOnce();
    expect(authorizeWrite).not.toHaveBeenCalled();
  },
);

test("an unavailable privilege probe does not record missing sudo", async () => {
  const { controls, broker } = fixture();
  const checked = vi.fn();
  vi.mocked(executeGuest).mockRejectedValueOnce(new GuestUnavailableError("connection lost"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      cache: { sizeGiB: 1, outcome: () => ({ promoted: false }), authorizeWrite: vi.fn(), checked },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "failed", code: "guest_unavailable" });
  expect(checked).not.toHaveBeenCalled();
  expect(broker.prepareRunner).not.toHaveBeenCalled();
  expect(controls.stop).toHaveBeenCalledOnce();
});

test.each(
  (["linux", "macos", "windows"] as const).flatMap((os) =>
    [false, true].map((preinstalled) => ({ os, preinstalled })),
  ),
)(
  "$os warm takeover with preinstalled=$preinstalled requests credentials only after guest verification",
  async ({ os, preinstalled }) => {
    const { controls, broker } = fixture(os);
    const connection = {
      host: "192.0.2.1",
      port: 22,
      user: "test",
      identityFile: "/unused/key",
      knownHostsFile: "/unused/hosts",
      hostKeyAlias: "warm",
    };
    const claimWarm = vi.fn(() => ({
      instance: {
        id: "warm",
        environmentId: environment.id,
        status: "running" as const,
        pid: 0,
        createdAt: "",
      },
      connection,
    }));
    broker.prepareRunner.mockImplementationOnce(async () => {
      expect(executeGuest).toHaveBeenCalledTimes(preinstalled ? 1 : 2);
      expect(executeGuest).toHaveBeenNthCalledWith(
        1,
        connection,
        "exit 0",
        expect.objectContaining({ shell: os === "windows" ? "powershell" : "bash" }),
      );
      return {
        state: "ready",
        cacheWrite: false,
        id: "lease",
        runnerId: 12,
        encodedConfig: "c2VjcmV0",
        environmentId: "test",
        access: { repositoryId: 2, actors: "any", approval: "automatic" },
        os,
      };
    });
    const result = await runRunnerTask(
      "binding",
      "key",
      {
        ...environment,
        os,
        ...(preinstalled
          ? {
              image: { revision: "revision", runnerVersion, provisionedAt: "2026-10-16T00:00:00Z" },
            }
          : {}),
      },
      { ...controls, claimWarm },
      AbortSignal.timeout(1000),
    );
    expect(result.status).toBe("succeeded");
    expect(
      Schema.decodeUnknownSync(RunnerProgress)(result.progress).phases?.map((phase) => phase.name),
    ).toEqual([
      "queued_locally",
      "warm_takeover",
      "guest_ready",
      preinstalled ? "runner_preinstalled" : "runner_install",
      "registration",
      "waiting_for_job",
      "cleanup",
    ]);
    expect(result.progress.phases?.every((phase) => phase.endedAt !== undefined)).toBe(true);
    expect(claimWarm).toHaveBeenCalledOnce();
    expect(controls.start).not.toHaveBeenCalled();
    expect(readyGuest).not.toHaveBeenCalled();
    expect(controls.stop).toHaveBeenCalledOnce();
  },
);

test("a failed warm health command stops the claim before a cold start", async () => {
  const { controls, broker, events } = fixture();
  const connection = {
    host: "192.0.2.1",
    port: 22,
    user: "test",
    identityFile: "/unused/key",
    knownHostsFile: "/unused/hosts",
    hostKeyAlias: "warm",
  };
  vi.mocked(executeGuest).mockResolvedValueOnce({
    exitCode: 1,
    stdout: "",
    stderr: "",
    truncated: false,
  });
  controls.start.mockImplementationOnce(async () => {
    expect(events).toEqual(["stop"]);
    expect(broker.prepareRunner).not.toHaveBeenCalled();
    return { id: "cold", environmentId: "test", status: "running", pid: 0, createdAt: "" };
  });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      claimWarm: () => ({
        instance: { id: "warm", environmentId: "test", status: "running", pid: 0, createdAt: "" },
        connection,
      }),
    },
    AbortSignal.timeout(1000),
  );
  expect(result.status).toBe("succeeded");
  expect(result.progress.instanceId).toBe("cold");
  expect(result.progress.phases?.map((phase) => phase.name)).toEqual([
    "queued_locally",
    "warm_takeover",
    "guest_ready",
    "vm_start",
    "guest_ready",
    "runner_install",
    "registration",
    "waiting_for_job",
    "cleanup",
  ]);
  expect(result.progress.phases?.every((phase) => phase.endedAt !== undefined)).toBe(true);
  expect(readyGuest).toHaveBeenCalledOnce();
  expect(controls.stop).toHaveBeenCalledTimes(2);
});

test("unconfirmed warm cleanup prevents cold fallback and JIT registration", async () => {
  const { controls, broker } = fixture();
  const connection = {
    host: "192.0.2.1",
    port: 22,
    user: "test",
    identityFile: "/unused/key",
    knownHostsFile: "/unused/hosts",
    hostKeyAlias: "warm",
  };
  vi.mocked(executeGuest).mockRejectedValueOnce(new GuestUnavailableError("SSH lost"));
  controls.stop.mockRejectedValue(new Error("unconfirmed"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      claimWarm: () => ({
        instance: { id: "warm", environmentId: "test", status: "running", pid: 0, createdAt: "" },
        connection,
      }),
    },
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({
    status: "action_required",
    code: "runner_cleanup_required",
    progress: { instanceId: "warm" },
  });
  expect(controls.start).not.toHaveBeenCalled();
  expect(broker.prepareRunner).not.toHaveBeenCalled();
});
test.each(["linux", "macos", "windows"] as const)(
  "%s starts the baked runner without an install when the manifest matches",
  async (os) => {
    const { controls } = fixture(os);
    const result = await runRunnerTask(
      "binding",
      "key",
      {
        ...environment,
        os,
        image: { revision: "revision", runnerVersion, provisionedAt: "2026-10-16T00:00:00Z" },
      },
      controls,
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.progress.phases?.map((phase) => phase.name)).toEqual([
      "queued_locally",
      "vm_start",
      "guest_ready",
      "runner_preinstalled",
      "registration",
      "waiting_for_job",
      "cleanup",
    ]);
    expect(result.progress.phases?.every((phase) => phase.endedAt !== undefined)).toBe(true);
    const scripts = vi.mocked(executeGuest).mock.calls.map((call) => call[1]);
    expect(scripts.some((script) => script.includes(preinstalledRunnerDirectory(os)))).toBe(true);
    expect(scripts.join("\n")).not.toMatch(/Invoke-WebRequest|curl --fail/);
    expect(scripts.join("\n")).toContain("--jitconfig");
    expect(controls.stop).toHaveBeenCalledOnce();
  },
);
test.each([undefined, "old-version"])(
  "a %s runner manifest uses the existing verified install path with a 600 s timeout",
  async (version) => {
    const { controls } = fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await runRunnerTask(
      "binding",
      "key",
      {
        ...environment,
        ...(version
          ? {
              image: {
                revision: "revision",
                runnerVersion: version,
                provisionedAt: "2026-10-16T00:00:00Z",
              },
            }
          : {}),
      },
      controls,
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(executeGuest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("curl --fail"),
      expect.objectContaining({ shell: "bash" }),
    );
    expect(timeout).toHaveBeenCalledWith(600000);
  },
);
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

test("phase history records ordered durations with the injected clock through job exit and cleanup", async () => {
  vi.useFakeTimers();
  const { controls, broker } = fixture();
  const base = Date.parse("2026-10-16T00:00:00.000Z");
  let clock = base + 5000;
  const instance = await controls.start();
  controls.start.mockClear();
  controls.start.mockImplementation(async () => {
    clock += 1200;
    return instance;
  });
  const connection = await readyGuest(environment, instance, new AbortController().signal);
  vi.mocked(readyGuest).mockClear();
  vi.mocked(readyGuest).mockImplementation(async () => {
    clock += 800;
    return connection;
  });
  const grant = await broker.prepareRunner();
  broker.prepareRunner.mockImplementation(async () => {
    clock += 200;
    return grant;
  });
  controls.stop.mockImplementation(async () => {
    clock += 200;
  });
  broker.releaseRunner.mockImplementation(async () => {
    clock += 300;
  });
  let finish = () => {};
  vi.mocked(executeGuest)
    .mockImplementationOnce(async () => {
      clock += 900;
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    })
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    });
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
  const result = runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      now: () => clock,
      acceptedAt: new Date(base).toISOString(),
      needed: async () => {
        clock += 100;
        return true;
      },
    },
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  clock += 30000;
  await vi.advanceTimersByTimeAsync(30000);
  clock += 10000;
  finish();
  const completed = await result;
  expect(completed.status).toBe("succeeded");
  expect(
    completed.progress.phases?.map((phase) => [
      phase.name,
      Date.parse(phase.endedAt ?? "") - Date.parse(phase.startedAt),
    ]),
  ).toEqual([
    ["queued_locally", 5000],
    ["job_check", 100],
    ["vm_start", 1200],
    ["guest_ready", 800],
    ["runner_install", 900],
    ["job_check", 100],
    ["registration", 200],
    ["waiting_for_job", 30000],
    ["job", 10000],
    ["cleanup", 500],
  ]);
  const snapshots = controls.progress.mock.calls.map(([value]) =>
    Schema.decodeUnknownSync(RunnerProgress)(value),
  );
  expect(snapshots[0]?.phases).toHaveLength(1);
  expect(snapshots.at(-1)).toEqual(completed.progress);
  expect(
    snapshots.some((snapshot) =>
      snapshot.phases?.some((phase) => phase.name === "job" && !phase.endedAt),
    ),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([undefined, "rosetta"] as const)(
  "%s startup attributes readiness inside environment.start to its startup phase",
  async (x64) => {
    const { controls } = fixture();
    const instance = await controls.start();
    controls.start.mockImplementation(async () => {
      clock += 6000;
      return instance;
    });
    let clock = Date.parse("2026-10-16T00:00:00.000Z");
    const result = await runRunnerTask(
      "binding",
      "key",
      { ...environment, ...(x64 ? { x64 } : {}) },
      { ...controls, now: () => clock },
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.progress.phases?.slice(1, 3)).toEqual([
      {
        name: x64 ? "vm_start_and_guest_ready" : "vm_start",
        startedAt: "2026-10-16T00:00:00.000Z",
        endedAt: "2026-10-16T00:00:06.000Z",
      },
      {
        name: "guest_ready",
        startedAt: "2026-10-16T00:00:06.000Z",
        endedAt: "2026-10-16T00:00:06.000Z",
      },
    ]);
  },
);

test("guest readiness failure closes the failed phase before timing cleanup", async () => {
  const { controls } = fixture();
  let clock = Date.parse("2026-10-16T00:00:00.000Z");
  vi.mocked(readyGuest).mockImplementation(async () => {
    clock += 8000;
    throw new GuestUnavailableError("SSH timeout");
  });
  controls.stop.mockImplementation(async () => {
    clock += 2000;
  });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    { ...controls, now: () => clock },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "failed", code: "guest_unavailable" });
  expect(
    result.progress.phases?.map((phase) => [
      phase.name,
      Date.parse(phase.endedAt ?? "") - Date.parse(phase.startedAt),
    ]),
  ).toEqual([
    ["queued_locally", 0],
    ["vm_start", 0],
    ["guest_ready", 8000],
    ["cleanup", 2000],
  ]);
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
  expect(result.progress.phases?.at(-1)).toMatchObject({
    name: "cleanup",
    endedAt: expect.any(String),
  });
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

async function listeningFixture(
  withJob = true,
  timings: Pick<
    Parameters<typeof runRunnerTask>[3],
    | "request"
    | "now"
    | "pollIntervalMs"
    | "idleTimeoutMs"
    | "offlineTimeoutMs"
    | "statusFailureTimeoutMs"
  > = {},
) {
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
    { ...controls, ...timings, ...(withJob ? { needed } : {}) },
    abort.signal,
  );
  listeningTasks.push({ abort, done });
  await vi.advanceTimersByTimeAsync(0);
  expect(controls.progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ stage: "listening" }),
  );
  return { controls, broker, events, abort, needed, done, complete };
}

test.each([{ busy: false, status: "online" as const }])(
  "an idle runner with status %j drains only after five minutes and releases capacity",
  async (status) => {
    let clock = Date.parse("2026-10-16T00:00:00.000Z");
    const { broker, events, needed, done } = await listeningFixture(true, { now: () => clock });
    broker.runnerStatus.mockResolvedValue(status);
    needed.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(events).toEqual([]);
    expect(needed).toHaveBeenCalledTimes(2);
    clock += 5 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(1);
    const completed = await done;
    expect(completed).toMatchObject({
      status: "cancelled",
      code: "runner_idle",
      progress: { stage: "finished" },
    });
    const phases = completed.progress.phases;
    expect(phases?.find((phase) => phase.name === "waiting_for_job")).toEqual({
      name: "waiting_for_job",
      startedAt: "2026-10-16T00:00:00.000Z",
      endedAt: "2026-10-16T00:05:00.000Z",
    });
    expect(phases?.some((phase) => phase.name === "job")).toBe(false);
    expect(phases?.every((phase) => phase.endedAt)).toBe(true);
    expect(events).toEqual(["stop", "release"]);
    expect(broker.releaseRunner).toHaveBeenCalledWith("lease", expect.any(AbortSignal));
    expect(collectRunnerDiagnostics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a busy runner keeps its VM even after the requested job no longer needs capacity", async () => {
  const { broker, events, needed, done, complete } = await listeningFixture();
  needed.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
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
  await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
  await vi.advanceTimersByTimeAsync(30000);
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
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
  const completed = await done;
  expect(completed).toMatchObject({ status: "succeeded" });
  const phases = completed.progress.phases;
  expect(phases).toHaveLength(16);
  expect(phases?.filter((phase) => phase.name === "job_check").length).toBeLessThan(
    needed.mock.calls.length,
  );
  expect(phases?.map((phase) => phase.name)).toEqual(
    expect.arrayContaining([
      "queued_locally",
      "vm_start",
      "guest_ready",
      "runner_install",
      "registration",
      "waiting_for_job",
      "cleanup",
    ]),
  );
  expect(phases?.every((phase) => phase.endedAt)).toBe(true);
});

test.each(["status", "job"] as const)(
  "%s lookup errors do not discard already observed idle time",
  async (lookup) => {
    const { broker, events, needed, done } = await listeningFixture();
    if (lookup === "status") {
      broker.runnerStatus.mockRejectedValue(new Error("GitHub unavailable"));
      needed.mockResolvedValue(false);
    } else needed.mockRejectedValue(new Error("Job unknown"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(events).toEqual([]);
    broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
    needed.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30000);
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
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
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

test("a manual runner without a requested job drains after five idle minutes", async () => {
  const { broker, events, done } = await listeningFixture(false);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await done).toMatchObject({ status: "cancelled", code: "runner_idle" });
  expect(broker.runnerStatus).toHaveBeenCalled();
  expect(events).toEqual(["stop", "release"]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([{ busy: false, status: "offline" as const }, { missing: true as const }])(
  "a runner reported as %j for two minutes stops even when its job is still needed",
  async (status) => {
    const { broker, events, done } = await listeningFixture();
    broker.runnerStatus.mockResolvedValue(status);
    await vi.advanceTimersByTimeAsync(30000 + 2 * 60000 - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toMatchObject({ status: "failed", code: "runner_offline" });
    expect(events).toEqual(["stop", "release"]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("offline observations must be consecutive and busy status prevents stopping", async () => {
  const { broker, events, done, complete } = await listeningFixture();
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "offline" });
  await vi.advanceTimersByTimeAsync(2 * 60000);
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
  await vi.advanceTimersByTimeAsync(30000);
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "offline" });
  await vi.advanceTimersByTimeAsync(2 * 60000);
  expect(events).toEqual([]);
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "offline" });
  await vi.advanceTimersByTimeAsync(5 * 60000);
  expect(events).toEqual([]);
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
});

test("fifteen minutes of continuous status failures treats the runner as offline", async () => {
  const { broker, events, done } = await listeningFixture();
  broker.runnerStatus.mockRejectedValue(new Error("GitHub unavailable"));
  await vi.advanceTimersByTimeAsync(30000 + 15 * 60000 - 1);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await done).toMatchObject({ status: "failed", code: "runner_offline" });
  expect(events).toEqual(["stop", "release"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("successful status reads restart the continuous status failure window", async () => {
  const { broker, events, done, complete } = await listeningFixture();
  broker.runnerStatus.mockRejectedValue(new Error("GitHub unavailable"));
  await vi.advanceTimersByTimeAsync(14 * 60000);
  broker.runnerStatus.mockResolvedValue({ busy: false, status: "online" });
  await vi.advanceTimersByTimeAsync(30000);
  broker.runnerStatus.mockRejectedValue(new Error("GitHub unavailable"));
  await vi.advanceTimersByTimeAsync(14 * 60000);
  expect(events).toEqual([]);
  complete();
  expect(await done).toMatchObject({ status: "succeeded" });
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

test.each([
  {
    name: "hook before any busy poll",
    marker: "1234",
    visibleAt: 0,
    finishAt: 25000,
    startAt: 1234,
  },
  {
    name: "short job read at listener exit",
    marker: "1234",
    visibleAt: 0,
    finishAt: 5000,
    startAt: 1234,
  },
  {
    name: "hook corrects an earlier busy observation",
    marker: "1234",
    visibleAt: 35000,
    finishAt: 35000,
    startAt: 1234,
  },
  {
    name: "slow guest clock clamps to registration end",
    marker: "-1000",
    visibleAt: 0,
    finishAt: 25000,
    startAt: 0,
  },
  {
    name: "fast guest clock clamps to observation time",
    marker: "60000",
    visibleAt: 0,
    finishAt: 25000,
    startAt: 10000,
  },
  ...[undefined, "invalid", "NaN", "Infinity", "1.5", "9007199254740992", "1234 trailing", ""].map(
    (marker) => ({
      name: `busy fallback for marker ${String(marker)}`,
      marker,
      visibleAt: 0,
      finishAt: 35000,
      startAt: 30000,
    }),
  ),
])("job timing uses $name", async ({ marker, visibleAt, finishAt, startAt }) => {
  vi.useFakeTimers();
  const base = Date.parse("2026-10-16T00:00:00.000Z");
  vi.setSystemTime(base);
  const { controls, broker } = fixture();
  const listener = heldListener();
  broker.runnerStatus.mockResolvedValue({ busy: true, status: "online" });
  const value =
    marker !== undefined && /^-?\d+$/.test(marker) && Number.isSafeInteger(Number(marker))
      ? String(base + Number(marker))
      : marker;
  vi.mocked(executeGuest).mockImplementation(async () => ({
    exitCode: 0,
    stdout:
      Date.now() - base >= visibleAt && value !== undefined
        ? `${jobStartedMarker}\r\n${value}\r\n`
        : "",
    stderr: "",
    truncated: false,
  }));
  const abort = new AbortController();
  const done = runRunnerTask("binding", "key", environment, controls, abort.signal);
  listeningTasks.push({ abort, done });
  await vi.advanceTimersByTimeAsync(finishAt);
  listener.finish?.();
  const result = await done;
  expect(result.status).toBe("succeeded");
  expect(
    result.progress.phases?.filter((phase) => ["waiting_for_job", "job"].includes(phase.name)),
  ).toEqual([
    {
      name: "waiting_for_job",
      startedAt: new Date(base).toISOString(),
      endedAt: new Date(base + startAt).toISOString(),
    },
    {
      name: "job",
      startedAt: new Date(base + startAt).toISOString(),
      endedAt: new Date(base + finishAt).toISOString(),
    },
  ]);
  expect(executeGuest).toHaveBeenCalledTimes(3 + Math.floor(finishAt / 10000));
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["linux", "macos", "windows"] as const)(
  "%s reads the job marker in the existing gate poll",
  async (os) => {
    vi.useFakeTimers();
    const base = Date.parse("2026-10-16T00:00:00.000Z");
    vi.setSystemTime(base);
    const { controls, broker } = fixture(os);
    const listener = heldListener();
    vi.mocked(executeGuest).mockResolvedValue({
      exitCode: 0,
      stdout: `${jobStartedMarker}\n${base + 1500}\n`,
      stderr: "",
      truncated: false,
    });
    const abort = new AbortController();
    const done = runRunnerTask("binding", "key", { ...environment, os }, controls, abort.signal);
    listeningTasks.push({ abort, done });
    await vi.advanceTimersByTimeAsync(10000);
    expect(broker.runnerStatus).not.toHaveBeenCalled();
    expect(executeGuest).toHaveBeenCalledTimes(3);
    expect(executeGuest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining("job-started"),
      expect.objectContaining({ shell: os === "windows" ? "powershell" : "bash" }),
    );
    expect(controls.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phases: expect.arrayContaining([
          { name: "job", startedAt: new Date(base + 1500).toISOString() },
        ]),
      }),
    );
    listener.finish?.();
    expect(await done).toMatchObject({ status: "succeeded" });
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a slow final gate read preserves listener exit time and clamps the guest start to it", async () => {
  vi.useFakeTimers();
  const base = Date.parse("2026-10-16T00:00:00.000Z");
  vi.setSystemTime(base);
  const { controls } = fixture();
  const listener = heldListener();
  vi.mocked(executeGuest).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return {
      exitCode: 0,
      stdout: `${jobStartedMarker}\n${base + 7000}\n`,
      stderr: "",
      truncated: false,
    };
  });
  const abort = new AbortController();
  const done = runRunnerTask("binding", "key", environment, controls, abort.signal);
  listeningTasks.push({ abort, done });
  await vi.advanceTimersByTimeAsync(5000);
  listener.finish?.();
  await vi.advanceTimersByTimeAsync(4000);
  const result = await done;
  expect(result.progress.phases?.find((phase) => phase.name === "job")).toEqual({
    name: "job",
    startedAt: new Date(base + 5000).toISOString(),
    endedAt: new Date(base + 5000).toISOString(),
  });
  expect(vi.getTimerCount()).toBe(0);
});

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

test.each(["stop", "release"] as const)(
  "assignment refusal survives failed %s cleanup",
  async (step) => {
    const { controls, broker } = fixture();
    const refusal = new VectisError(
      "runner_assignment_rejected",
      "Vectis refused an unapproved assigned job.",
    );
    vi.mocked(executeGuest)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
      .mockRejectedValueOnce(refusal);
    if (step === "stop") controls.stop.mockRejectedValue(new Error("VM exit unknown"));
    else broker.releaseRunner.mockRejectedValue(new VectisError("runner_busy", "Runner is busy."));
    const result = await runRunnerTask(
      "binding",
      "key",
      environment,
      controls,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "action_required",
      code: "runner_cleanup_required",
      message: expect.stringContaining("Vectis refused the assigned job"),
      progress: { cause: { code: refusal.code, message: refusal.message } },
    });
    if (step === "stop") expect(broker.releaseRunner).not.toHaveBeenCalled();
  },
);

test("a prepare failure before a lease claim is fenced and becomes retryable", async () => {
  const { controls, broker } = fixture();
  broker.prepareRunner.mockRejectedValue(new Error("Token request failed"));
  broker.reconcileRunner.mockResolvedValue({
    id: "fence",
    bindingId: "binding",
    environmentId: "test",
    phase: "released",
  });
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ status: "failed", code: "runner_registration_failed" });
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(broker.reconcileRunner).toHaveBeenCalledWith(
    { bindingId: "binding", environmentId: "test", key: "key" },
    expect.any(AbortSignal),
  );
  expect(broker.releaseRunner).not.toHaveBeenCalled();
});

test("a lost prepare response with a claimed lease waits for release confirmation", async () => {
  const { controls, broker } = fixture();
  broker.prepareRunner.mockRejectedValue(new Error("Response lost"));
  broker.reconcileRunner.mockResolvedValue({
    id: "lease",
    bindingId: "binding",
    environmentId: "test",
    phase: "ready",
  });
  broker.releaseRunner.mockRejectedValue(new Error("Release unconfirmed"));
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
    progress: { leaseId: "lease" },
  });
});

test("a locally rejected prepare request is retryable without requiring cloud reconciliation", async () => {
  const { controls, broker } = fixture();
  broker.prepareRunner.mockRejectedValue(new VectisError("cloud_unavailable", "Disconnected"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    controls,
    AbortSignal.timeout(1000),
  );
  expect(result).toMatchObject({ status: "failed", code: "runner_registration_failed" });
  expect(broker.reconcileRunner).not.toHaveBeenCalled();
  expect(controls.stop).toHaveBeenCalledOnce();
});

test.each(["idle", "offline", "errors"] as const)(
  "watchdog %s timings are injectable",
  async (state) => {
    const { broker, done } = await listeningFixture(false, {
      pollIntervalMs: 10,
      idleTimeoutMs: 40,
      offlineTimeoutMs: 20,
      statusFailureTimeoutMs: 30,
      now: () => Date.now(),
    });
    if (state === "offline") broker.runnerStatus.mockResolvedValue({ missing: true });
    if (state === "errors") broker.runnerStatus.mockRejectedValue(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(state === "offline" ? 30 : 40);
    expect(await done).toMatchObject({
      status: state === "idle" ? "cancelled" : "failed",
      code: state === "idle" ? "runner_idle" : "runner_offline",
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("offline failure survives unconfirmed VM cleanup", async () => {
  const { controls, broker, done } = await listeningFixture(false, {
    pollIntervalMs: 10,
    offlineTimeoutMs: 20,
  });
  controls.stop.mockRejectedValue(new Error("Exit unconfirmed"));
  broker.runnerStatus.mockResolvedValue({ missing: true });
  await vi.advanceTimersByTimeAsync(30);
  expect(await done).toMatchObject({
    status: "action_required",
    code: "runner_cleanup_required",
    recoveryCause: { code: "runner_offline" },
  });
  expect(broker.releaseRunner).not.toHaveBeenCalled();
});

test.each([true, false])(
  "cache promotion requires cacheWrite=%s and a clean unmount before VM stop",
  async (cacheWrite) => {
    const { controls, broker, events } = fixture();
    const grant = await broker.prepareRunner();
    const checked = vi.fn();
    const prepareRunner = vi.fn(async () => {
      expect(checked).toHaveBeenCalledExactlyOnceWith(true);
      expect(vi.mocked(executeGuest).mock.calls[0]?.[1]).toBe("sudo -n true\n");
      return {
        ...grant,
        cacheWrite,
        access: {
          ...grant.access,
          ...(cacheWrite ? { cacheRun: { runId: 5, runAttempt: 1 } } : {}),
        },
      };
    });
    let promoted = false;
    const authorizeWrite = vi.fn(() => {
      events.push("authorize");
      expect(promoted).toBe(false);
    });
    controls.stop.mockImplementation(async () => {
      events.push("stop");
      if (authorizeWrite.mock.calls.length) {
        events.push("promote");
        promoted = true;
      }
    });
    vi.mocked(executeGuest).mockImplementation(async (_connection, script) => {
      if (script.includes("sudo -n umount /vectis-cache")) events.push("unmount");
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    });
    const result = await runRunnerTask(
      "binding",
      "key",
      environment,
      {
        ...controls,
        broker: { ...broker, prepareRunner },
        cache: { sizeGiB: 20, outcome: () => ({ promoted }), authorizeWrite, checked },
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(result.progress.cache).toEqual({
      attached: true,
      writeBack: cacheWrite ? "granted" : "denied",
      promoted: cacheWrite,
      reason: cacheWrite ? undefined : "policy_denied",
    });
    expect(events).toEqual(
      cacheWrite
        ? ["unmount", "authorize", "stop", "promote", "release"]
        : ["unmount", "stop", "release"],
    );
  },
);

test("a failed cache unmount discards even a trusted writer", async () => {
  const { controls, broker } = fixture();
  const grant = await broker.prepareRunner();
  const authorizeWrite = vi.fn();
  vi.mocked(executeGuest).mockImplementation(async (_connection, script) => ({
    exitCode: script.includes("sudo -n umount /vectis-cache") ? 1 : 0,
    stdout: "",
    stderr: "",
    truncated: false,
  }));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      broker: {
        ...broker,
        prepareRunner: async () => ({
          ...grant,
          cacheWrite: true,
          access: { ...grant.access, cacheRun: { runId: 5, runAttempt: 1 } },
        }),
      },
      cache: { sizeGiB: 20, outcome: () => ({ promoted: false }), authorizeWrite },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "failed",
    code: "cache_unmount_failed",
    progress: {
      cache: {
        attached: true,
        writeBack: "granted",
        promoted: false,
        reason: "cache_unmount_failed",
      },
    },
  });
  expect(authorizeWrite).not.toHaveBeenCalled();
  expect(controls.stop).toHaveBeenCalledOnce();
});

test.each(["linux", "macos", "windows"] as const)(
  "%s baked scale set runners attach caches without claiming warm VMs or checking demand",
  async (os) => {
    const { controls, broker } = fixture(os);
    const claimWarm = vi.fn(() => {
      throw new Error("A generic warm VM has no cache disk");
    });
    const needed = vi.fn(async () => false);
    const request = { automatic: true, scaleSet: { generation: 3 } };
    const signal = new AbortController().signal;
    const result = await runRunnerTask(
      "binding",
      "cache-cold",
      {
        ...environment,
        os,
        image: { revision: "revision", runnerVersion, provisionedAt: "2026-10-16T00:00:00Z" },
      },
      {
        ...controls,
        claimWarm,
        needed,
        request,
        cache: { sizeGiB: 1, outcome: () => ({ promoted: false }), authorizeWrite: vi.fn() },
      },
      signal,
    );
    expect(result.status).toBe("succeeded");
    expect(broker.prepareRunner).toHaveBeenCalledWith("binding", "cache-cold", signal, request);
    expect(claimWarm).not.toHaveBeenCalled();
    expect(needed).not.toHaveBeenCalled();
    expect(controls.start).toHaveBeenCalledOnce();
    expect(readyGuest).toHaveBeenCalledOnce();
    expect(result.progress.phases?.map((phase) => phase.name)).toEqual([
      "queued_locally",
      "vm_start",
      "guest_ready",
      "runner_preinstalled",
      "registration",
      "waiting_for_job",
      "cleanup",
    ]);
    const scripts = vi.mocked(executeGuest).mock.calls.map((call) => call[1]);
    const listener = scripts.find((script) => script.includes("--jitconfig"));
    expect(listener).toContain(preinstalledRunnerDirectory(os));
    expect(listener).toContain("VECTISCACHE");
    expect(scripts.join("\n")).not.toMatch(/Invoke-WebRequest|curl --fail/);
    expect(controls.stop).toHaveBeenCalledOnce();
  },
);

test("cache jobs boot with their attached disk instead of claiming a generic warm VM", async () => {
  const { controls } = fixture();
  const claimWarm = vi.fn(() => {
    throw new Error("A generic warm VM has no cache disk");
  });
  const result = await runRunnerTask(
    "binding",
    "cache-cold",
    environment,
    {
      ...controls,
      claimWarm,
      cache: { sizeGiB: 1, outcome: () => ({ promoted: false }), authorizeWrite: vi.fn() },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("succeeded");
  expect(claimWarm).not.toHaveBeenCalled();
  expect(controls.start).toHaveBeenCalledOnce();
  expect(readyGuest).toHaveBeenCalledOnce();
  expect(result.progress.phases?.map((phase) => phase.name)).toContain("vm_start");
  expect(result.progress.phases?.map((phase) => phase.name)).not.toContain("warm_takeover");
});

test.each(["linux", "macos", "windows"] as const)(
  "%s scale set registration forwards its generation without per-job checks",
  async (os) => {
    const { controls, broker } = fixture(os);
    const needed = vi.fn(async () => false);
    const request = { automatic: true, scaleSet: { generation: 3 } };
    const signal = new AbortController().signal;
    const result = await runRunnerTask(
      "binding",
      "key",
      { ...environment, os },
      { ...controls, needed, request },
      signal,
    );
    expect(broker.prepareRunner).toHaveBeenCalledWith("binding", "key", signal, request);
    expect(needed).not.toHaveBeenCalled();
    expect(result.status).toBe("succeeded");
  },
);

test("a scale set runner drains after five idle minutes even if a supplied demand check says needed", async () => {
  const { needed, done } = await listeningFixture(true, {
    request: { automatic: true, scaleSet: { generation: 3 } },
  });
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(await done).toMatchObject({ status: "cancelled", code: "runner_idle" });
  expect(needed).not.toHaveBeenCalled();
});

test("cache promotion failures remain visible when VM cleanup requires reconciliation", async () => {
  const { controls, broker } = fixture();
  const grant = await broker.prepareRunner();
  controls.stop.mockRejectedValue(new Error("Synthetic promotion failure"));
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      broker: {
        ...broker,
        prepareRunner: async () => ({
          ...grant,
          cacheWrite: true,
          access: { ...grant.access, cacheRun: { runId: 5, runAttempt: 1 } },
        }),
      },
      cache: {
        sizeGiB: 1,
        authorizeWrite: vi.fn(),
        outcome: () => ({ promoted: false, reason: "promotion_failed" }),
      },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "action_required",
    code: "runner_cleanup_required",
    progress: {
      cache: { attached: true, writeBack: "granted", promoted: false, reason: "promotion_failed" },
    },
  });
  expect(broker.releaseRunner).not.toHaveBeenCalled();
});

test("cache denial reasons from the cloud survive a successful runner lifecycle", async () => {
  const { controls, broker } = fixture();
  const grant = await broker.prepareRunner();
  const authorizeWrite = vi.fn();
  const result = await runRunnerTask(
    "binding",
    "key",
    environment,
    {
      ...controls,
      broker: {
        ...broker,
        prepareRunner: async () => ({ ...grant, cacheWriteReason: "metadata_access_denied" }),
      },
      cache: { sizeGiB: 1, authorizeWrite, outcome: () => ({ promoted: false }) },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "succeeded",
    progress: {
      cache: {
        attached: true,
        writeBack: "denied",
        promoted: false,
        reason: "metadata_access_denied",
      },
    },
  });
  expect(authorizeWrite).not.toHaveBeenCalled();
});
