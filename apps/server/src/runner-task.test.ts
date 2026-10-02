import { afterEach, expect, test, vi } from "vitest";
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
afterEach(() => vi.resetAllMocks());
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
    findRunner: vi.fn(async () => null),
    prepareRunner: vi.fn(async () => ({
      state: "ready" as const,
      id: "lease",
      runnerId: 12,
      encodedConfig: "c2VjcmV0",
      environmentId: "test",
      os: "linux" as const,
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
