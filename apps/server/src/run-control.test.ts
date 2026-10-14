import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import {
  type RunControlOutcome,
  type RunControlBroker,
} from "../../../packages/protocol/src/runs.js";
import { unconfirmedRunCommand } from "../../../packages/github/src/run-control.js";
import { VectisError } from "../../../packages/protocol/src/index.js";

const command = { type: "run.cancel", bindingId: "binding", runId: 5 } as const;
async function fixture(controlRun: RunControlBroker["controlRun"]) {
  const home = await mkdtemp(join(tmpdir(), "vectis-run-control-"));
  const store = new Store(join(home, "state.sqlite"));
  const service = new Service(store, new VmRuntime({ home }), () => ({
    controlRun,
    analyzeMigration: async () => {
      throw new Error("unused");
    },
    publishMigration: async () => {
      throw new Error("unused");
    },
    scanJobs: async () => ({ runs: 0, jobs: 0, complete: true }),
    refreshJob: async () => {
      throw new Error("unused");
    },
    repositories: async () => [],
    connectRepository: async () => "unused",
    disconnectRepository: async () => {},
    setAutomatic: async () => {},
    findRunner: async () => null,
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    releaseRunner: async () => {},
  }));
  return {
    store,
    service,
    close: async () => {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const outcomes: RunControlOutcome[] = [
  {
    state: "accepted",
    message: "Cancellation observed.",
    cancellation: "observed",
    runId: 5,
    runAttempt: 1,
    htmlUrl: "https://github.com/owner/repo/actions/runs/5",
  },
  {
    state: "accepted",
    message: "GitHub accepted the cancellation; the run is still stopping.",
    cancellation: "requested",
    runId: 5,
  },
  {
    state: "accepted",
    message: "GitHub accepted the rerun; the new attempt is not yet visible.",
    rerun: "requested",
    runId: 5,
  },
  unconfirmedRunCommand(command),
  {
    state: "rejected",
    code: "run_not_active",
    message: "Run completed.",
    nextStep: "Select an active run.",
  },
  {
    state: "rejected",
    code: "github_app_permission_required",
    message: "Permission required.",
    nextStep: "Approve updated permissions.",
  },
];
test.each(outcomes)(
  "service maps $state $message without claiming job completion",
  async (outcome) => {
    const controlRun = vi.fn(async () => outcome);
    const f = await fixture(controlRun);
    try {
      const operation = f.service.submit("caller-key", command);
      await f.service.drain();
      await vi.waitFor(() =>
        expect(f.store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
          outcome.state === "accepted"
            ? "succeeded"
            : outcome.state === "uncertain" || outcome.code === "github_app_permission_required"
              ? "action_required"
              : "failed",
        ),
      );
      expect(
        f.store.snapshot().operations.find((item) => item.id === operation.id)?.result,
      ).toEqual(outcome);
      expect(controlRun).toHaveBeenCalledWith(command, "caller-key", expect.any(AbortSignal));
      expect(f.service.submit("caller-key", command).id).toBe(operation.id);
      expect(controlRun).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  },
);

test("run control stays cancellable without blocking machine control and never claims cancellation of an external effect", async () => {
  const controlRun = vi.fn(
    (_command, _key, signal: AbortSignal) =>
      new Promise<RunControlOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const f = await fixture(controlRun);
  try {
    const operation = f.service.submit("run", command);
    await f.service.drain();
    f.service.submit("pause", { type: "machine.pause", paused: true });
    await f.service.drain();
    expect(f.store.snapshot().machine.paused).toBe(true);
    f.service.submit("cancel-wait", { type: "operation.cancel", id: operation.id });
    await f.service.drain();
    await vi.waitFor(() =>
      expect(f.store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "action_required",
      ),
    );
    expect(
      f.store.snapshot().operations.find((item) => item.id === operation.id)?.result,
    ).toMatchObject({ code: "run_command_unconfirmed" });
  } finally {
    await f.close();
  }
});

test("coded relay rejections retain their recovery instruction", async () => {
  const f = await fixture(async () => {
    throw new VectisError(
      "github_app_permission_required",
      "App update needed.",
      "Approve updated permissions.",
    );
  });
  try {
    const operation = f.service.submit("permission", command);
    await f.service.drain();
    await vi.waitFor(() =>
      expect(f.store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "action_required",
      ),
    );
    expect(
      f.store.snapshot().operations.find((item) => item.id === operation.id)?.result,
    ).toMatchObject({
      code: "github_app_permission_required",
      nextStep: "Approve updated permissions.",
    });
  } finally {
    await f.close();
  }
});
