import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { JobRefresh } from "../../../packages/protocol/src/jobs.js";

test("job refresh does not block machine control and retries reuse its durable operation", async () => {
  const store = new Store(":memory:");
  const refreshJob = vi.fn(
    (_bindingId: string, _jobId: number, signal: AbortSignal) =>
      new Promise<JobRefresh>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }), () => ({
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
    refreshJob,
    connectRepository: async () => "binding",
    disconnectRepository: async () => {},
    setAccess: async () => {},
    setAutomatic: async () => {},
    repositories: async () => [],
    reconcileRunner: async () => {
      throw new Error("unused");
    },
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    releaseRunner: async () => {},
  }));
  try {
    const command = { type: "job.refresh" as const, bindingId: "binding", jobId: 4 };
    const operation = service.submit("refresh", command);
    await service.drain();
    expect(service.submit("refresh", command).id).toBe(operation.id);
    expect(refreshJob).toHaveBeenCalledOnce();
    service.submit("pause", { type: "machine.pause", paused: true });
    await service.drain();
    expect(store.snapshot().machine.paused).toBe(true);
    service.submit("cancel", { type: "operation.cancel", id: operation.id });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "cancelled",
      ),
    );
  } finally {
    await service.close();
    store.close();
  }
});

test("disabling automatic admission cancels a queued demand before guest startup or API access", async () => {
  const store = new Store(":memory:");
  const refreshJob = vi.fn(async () => ({
    jobId: 4,
    runId: 2,
    name: "Build",
    runnerId: null,
    runnerName: null,
    updatedAt: 1,
    status: "queued" as const,
    conclusion: null,
    labels: ["vectis-mac"],
  }));
  const runtime = new VmRuntime({ home: "/unused-isolated-home" });
  const start = vi.spyOn(runtime, "start");
  const service = new Service(store, runtime, () => ({
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
    refreshJob,
    connectRepository: async () => "binding",
    disconnectRepository: async () => {},
    setAccess: async () => {},
    setAutomatic: async () => {},
    repositories: async () => [
      {
        id: "binding",
        repositoryId: 1,
        repositoryName: "test/repo",
        environmentId: "mac",
        automatic: false,
      },
    ],
    reconcileRunner: async () => {
      throw new Error("unused");
    },
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    releaseRunner: async () => {},
  }));
  store.put("environment", "mac", {
    id: "mac",
    name: "Mac",
    os: "macos",
    state: "ready",
    cpu: 2,
    memoryMiB: 4096,
    basePath: "/unused/base",
  });
  try {
    const operation = service.submit("automatic", {
      type: "runner.run",
      bindingId: "binding",
      jobId: 4,
      automatic: true,
    });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "cancelled",
      ),
    );
    expect(refreshJob).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    await service.close();
    store.close();
    start.mockRestore();
  }
});

test("incomplete repository scans require attention instead of claiming full recovery", async () => {
  const store = new Store(":memory:");
  const scanJobs = vi.fn(async () => ({ runs: 2, jobs: 50, complete: false }));
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }), () => ({
    analyzeMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    publishMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
    jobLogs: async () => {
      throw new Error("Unexpected job log read.");
    },
    scanJobs,
    refreshJob: async () => ({
      jobId: 1,
      runId: 2,
      name: "Build",
      runnerId: null,
      runnerName: null,
      updatedAt: 1,
      labels: [],
      status: "queued",
      conclusion: null,
    }),
    repositories: async () => [],
    connectRepository: async () => "binding",
    disconnectRepository: async () => {},
    setAccess: async () => {},
    setAutomatic: async () => {},
    reconcileRunner: async () => {
      throw new Error("unused");
    },
    prepareRunner: async () => ({ state: "released", id: "unused" }),
    runnerStatus: async () => ({ busy: false, status: "online" as const }),
    releaseRunner: async () => {},
  }));
  try {
    const operation = service.submit("scan", { type: "job.scan", bindingId: "binding" });
    await service.drain();
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
        "action_required",
      ),
    );
    expect(scanJobs).toHaveBeenCalledOnce();
  } finally {
    await service.close();
    store.close();
  }
});

test.each([
  { actorId: 8, triggeringActorId: 7, automatic: false, code: "actor_not_allowed" },
  { actorId: 7, triggeringActorId: 8, automatic: false, code: "actor_not_allowed" },
  { actorId: 7, triggeringActorId: undefined, automatic: false, code: "actor_unknown" },
  { actorId: 7, triggeringActorId: 7, automatic: true, code: "approval_required" },
])(
  "$code is refused before the local service starts capacity",
  async ({ actorId, triggeringActorId, automatic, code }) => {
    const store = new Store(":memory:");
    const runtime = new VmRuntime({ home: "/unused-isolated-home" });
    const start = vi.spyOn(runtime, "start");
    const service = new Service(store, runtime, () => ({
      analyzeMigration: async () => {
        throw new Error("unused");
      },
      publishMigration: async () => {
        throw new Error("unused");
      },
      scanJobs: async () => ({ runs: 0, jobs: 0, complete: true }),
      refreshJob: async () => ({
        jobId: 4,
        runId: 5,
        runAttempt: 1,
        actorId,
        triggeringActorId,
        name: "Build",
        status: "queued",
        conclusion: null,
        labels: ["vectis-mac"],
        runnerId: null,
        runnerName: null,
        updatedAt: 1,
      }),
      connectRepository: async () => "binding",
      disconnectRepository: async () => {},
      setAccess: async () => {},
      setAutomatic: async () => {},
      repositories: async () => [
        {
          id: "binding",
          repositoryId: 2,
          repositoryName: "test/repo",
          environmentId: "mac",
          automatic: true,
          access: { actors: { ids: [7] }, approval: "required" },
        },
      ],
      reconcileRunner: async () => {
        throw new Error("Must not reconcile a runner");
      },
      jobLogs: async () => {
        throw new Error("Must not read job logs");
      },
      prepareRunner: async () => {
        throw new Error("Must not register a runner");
      },
      releaseRunner: async () => {},
      runnerStatus: async () => ({ busy: false, status: "online" as const }),
    }));
    store.put("environment", "mac", {
      id: "mac",
      name: "Mac",
      os: "macos",
      state: "ready",
      cpu: 2,
      memoryMiB: 4096,
      basePath: "/unused/base",
    });
    try {
      const operation = service.submit("denied", {
        type: "runner.run",
        bindingId: "binding",
        jobId: 4,
        ...(automatic ? { automatic: true } : {}),
      });
      await service.drain();
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
          status: "failed",
          result: { code },
        }),
      );
      expect(start).not.toHaveBeenCalled();
      expect(store.snapshot().instances).toHaveLength(0);
    } finally {
      await service.close();
      store.close();
      start.mockRestore();
    }
  },
);
