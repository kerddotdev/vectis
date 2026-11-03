import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Job } from "../../../packages/protocol/src/jobs.js";
import type { RunControlCommand, RunControlOutcome } from "../../../packages/protocol/src/runs.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { activityFor } from "./activities.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { reconcileInfraReruns } from "./infra-rerun.js";

function seed(store: Store, id: string, code: string) {
  const command = { type: "runner.run", bindingId: "binding" } as const;
  const runner = store.accept(id, id, command.type, activityFor(id, command), id).operation;
  store.update(runner, {
    status: "failed",
    result: {
      bindingId: "binding",
      environmentId: "linux",
      leaseKey: id,
      leaseId: id,
      stage: "finished",
      recoveryCause: { code, message: "Synthetic failure" },
    },
  });
}
const job: Job = {
  jobId: 1,
  runId: 42,
  runAttempt: 1,
  name: "Build",
  status: "completed",
  conclusion: "failure",
  labels: [],
  runnerId: 3,
  runnerName: "runner",
  updatedAt: 1,
};

function broker() {
  return {
    controlRun: vi.fn(
      async (
        _command: RunControlCommand,
        _key: string,
        _signal: AbortSignal,
      ): Promise<RunControlOutcome> => ({
        state: "accepted" as const,
        rerun: "requested" as const,
        message: "GitHub accepted the retry.",
      }),
    ),
    setInfraRerun: vi.fn(async (_binding: string, _enabled: boolean) => {}),
    setAutomatic: async () => {},
    setAccess: async () => {},
    repositories: async () => [],
    connectRepository: async () => "unused",
    disconnectRepository: async () => {},
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
    jobLogs: async () => {
      throw new Error("unused");
    },
    reconcileRunner: async () => {
      throw new Error("unused");
    },
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    prepareRunner: async () => ({ state: "released" as const, id: "unused" }),
    releaseRunner: async () => {},
  };
}

test.each([
  [true, "guest_unavailable", "failure", 1],
  [true, "runner_offline", "failure", 1],
  [true, "storage_io_error", "failure", 1],
  [true, "runner_process_failed", "failure", 0],
  [true, "workflow_failed", "failure", 0],
  [false, "guest_unavailable", "failure", 0],
  [true, "guest_unavailable", "success", 0],
  [true, "guest_unavailable", "cancelled", 0],
] as const)(
  "policy=%s cause=%s conclusion=%s submits %s retry across restart",
  async (enabled, code, conclusion, count) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-infra-rerun-"));
    const path = join(home, "state.sqlite");
    let store = new Store(path);
    const connection = broker();
    const bindings = [
      {
        id: "binding",
        repositoryId: 1,
        repositoryName: "owner/repo",
        environmentId: "linux",
        infraRerun: enabled,
      },
    ];
    const create = () =>
      new Service(
        store,
        new VmRuntime({ home }),
        () => connection,
        undefined,
        () => bindings,
      );
    let service = create();
    try {
      seed(store, "runner", code);
      const observations = [{ leaseId: "runner", job: { ...job, conclusion } }];
      service.observeJobs(observations);
      service.observeJobs(observations);
      await vi.waitFor(() => expect(connection.controlRun).toHaveBeenCalledTimes(count));
      if (count) {
        expect(connection.controlRun).toHaveBeenCalledWith(
          {
            type: "run.rerun-failed",
            bindingId: "binding",
            runId: 42,
            expectedRunAttempt: 1,
            infraJobIds: [1],
          },
          "infra-rerun:binding:42:1",
          expect.any(AbortSignal),
        );
        const retry = store.operationByKey("infra-rerun:binding:42:1");
        await vi.waitFor(() => expect(store.operation(retry!.id)?.status).toBe("succeeded"));
        expect(store.operation("runner")?.result).toMatchObject({
          infraRerun: { runId: 42, attempt: 1, operationId: retry?.id },
        });
        seed(store, "second", code);
        service.observeJobs([{ leaseId: "second", job: { ...job, runAttempt: 2 } }]);
      }
      await service.close();
      store.close();
      store = new Store(path);
      service = create();
      service.observeJobs(observations);
      await service.close();
      expect(connection.controlRun).toHaveBeenCalledTimes(count);
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("policy toggle uses the setting command contract and returns the stored setting", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-infra-toggle-"));
  const store = new Store(join(home, "state.sqlite"));
  const connection = broker();
  const service = new Service(store, new VmRuntime({ home }), () => connection);
  try {
    for (const enabled of [true, false]) {
      const operation = service.submit(`toggle-${enabled}`, {
        type: "repository.infra-rerun",
        bindingId: "binding",
        enabled,
      });
      await vi.waitFor(() => expect(store.operation(operation.id)?.status).toBe("succeeded"));
      expect(connection.setInfraRerun).toHaveBeenLastCalledWith("binding", enabled);
      expect(store.operation(operation.id)?.result).toEqual({
        bindingId: "binding",
        infraRerun: enabled,
      });
    }
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("restart resumes a persisted decision whose request was interrupted before submission", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-infra-interrupted-"));
  const path = join(home, "state.sqlite");
  let store = new Store(path);
  seed(store, "runner", "guest_unavailable");
  const key = "infra-rerun:binding:42:1";
  store.put("infra-rerun", key, {
    bindingId: "binding",
    runId: 42,
    attempt: 1,
    runnerOperationId: "runner",
    infraJobIds: [1],
  });
  const request = store.accept(key, "synthetic", "run.rerun-failed").operation;
  store.update(request, { status: "running" });
  store.close();
  store = new Store(path);
  const connection = broker();
  const service = new Service(
    store,
    new VmRuntime({ home }),
    () => connection,
    undefined,
    () => [
      {
        id: "binding",
        repositoryId: 1,
        repositoryName: "owner/repo",
        environmentId: "linux",
        infraRerun: true,
      },
    ],
  );
  try {
    service.observeJobs([]);
    await vi.waitFor(() => expect(store.operation(request.id)?.status).toBe("succeeded"));
    expect(connection.controlRun).toHaveBeenCalledTimes(1);
    expect(store.operationByKey(key)?.id).toBe(request.id);
    expect(store.operation("runner")?.result).toMatchObject({
      infraRerun: { operationId: request.id },
    });
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("completed decisions survive activity pruning without resubmitting", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-infra-retained-"));
  const store = new Store(join(home, "state.sqlite"));
  const key = "infra-rerun:binding:42:1";
  const command = {
    type: "run.rerun-failed",
    bindingId: "binding",
    runId: 42,
    expectedRunAttempt: 1,
  } as const;
  const operation = store.accept(key, "synthetic", command.type).operation;
  store.update(operation, { status: "succeeded" });
  store.put("infra-rerun", key, {
    bindingId: "binding",
    runId: 42,
    attempt: 1,
    runnerOperationId: "pruned-runner",
    infraJobIds: [1],
  });
  const submit = vi.fn(() => store.operationByKey(key));
  const bindings = [
    {
      id: "binding",
      repositoryId: 1,
      repositoryName: "owner/repo",
      environmentId: "linux",
      infraRerun: true,
    },
  ];
  try {
    reconcileInfraReruns(store, bindings, submit);
    store.remove("operation", operation.id);
    reconcileInfraReruns(store, bindings, submit);
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an active workflow waits and retries the same command after its remaining jobs finish", async () => {
  vi.useFakeTimers();
  const home = await mkdtemp(join(tmpdir(), "vectis-infra-wait-"));
  const store = new Store(join(home, "state.sqlite"));
  const connection = broker();
  connection.controlRun.mockResolvedValueOnce({
    state: "rejected",
    code: "run_not_ready",
    message: "Still active",
    nextStep: "Wait",
  });
  const service = new Service(
    store,
    new VmRuntime({ home }),
    () => connection,
    undefined,
    () => [
      {
        id: "binding",
        repositoryId: 1,
        repositoryName: "owner/repo",
        environmentId: "linux",
        infraRerun: true,
      },
    ],
  );
  try {
    seed(store, "runner", "guest_unavailable");
    service.observeJobs([{ leaseId: "runner", job }]);
    await service.drain();
    await vi.advanceTimersByTimeAsync(29000);
    expect(connection.controlRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(connection.controlRun).toHaveBeenCalledTimes(2);
    expect(connection.controlRun.mock.calls.map((call) => call[1])).toEqual([
      "infra-rerun:binding:42:1",
      "infra-rerun:binding:42:1",
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.controlRun).toHaveBeenCalledTimes(2);
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
