import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Job } from "../../../packages/protocol/src/jobs.js";
import type { Operation } from "../../../packages/protocol/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { activityFor } from "./activities.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

afterEach(() => vi.useRealTimers());

function seed(store: Store, id: string, status: Operation["status"], jobId?: number) {
  const command = {
    type: "runner.run" as const,
    bindingId: "binding",
    ...(jobId === undefined ? {} : { jobId }),
  };
  const operation = store.accept(id, id, command.type, activityFor(id, command), id).operation;
  return store.update(operation, {
    status,
    message: status === "failed" ? "Runner cleanup failed." : "Runner finished.",
    result: {
      bindingId: "binding",
      environmentId: "linux",
      leaseKey: id,
      leaseId: `lease-${id}`,
      stage: "finished",
    },
  });
}

const job: Job = {
  jobId: 99,
  runId: 2,
  name: "Actual build",
  workflowName: "CI",
  htmlUrl: "https://github.com/test/repo/actions/runs/2/job/99",
  status: "in_progress",
  conclusion: null,
  labels: [],
  runnerId: 3,
  runnerName: "vectis-lease-runner",
  updatedAt: 1,
};

test.each([
  ["succeeded", "failure", 1],
  ["failed", "success", undefined],
] as const)(
  "a %s runner preserves its outcome when the actual job reports %s after restart",
  async (status, conclusion, requestedId) => {
    vi.useFakeTimers();
    const home = await mkdtemp(join(tmpdir(), "vectis-job-observation-"));
    const path = join(home, "state.sqlite");
    let store = new Store(path);
    const watch = vi.fn();
    let service = new Service(
      store,
      new VmRuntime({ home }),
      undefined,
      undefined,
      undefined,
      watch,
    );
    try {
      seed(store, "runner", status, requestedId);
      await vi.advanceTimersByTimeAsync(1000);
      expect(watch).toHaveBeenLastCalledWith(["lease-runner"]);
      service.observeJobs([{ leaseId: "lease-runner", job }]);
      const activity = () => store.snapshot().activities?.find((item) => item.id === "runner");
      expect(activity()).toMatchObject({
        status,
        subject: { actualJob: { jobId: 99, status: "in_progress" } },
      });
      const revision = store.snapshot().revision;
      service.observeJobs([{ leaseId: "lease-runner", job }]);
      expect(store.snapshot().revision).toBe(revision);
      await service.close();
      store.close();
      store = new Store(path);
      watch.mockClear();
      service = new Service(store, new VmRuntime({ home }), undefined, undefined, undefined, watch);
      expect(activity()).toMatchObject({
        status,
        subject: { actualJob: { jobId: 99, status: "in_progress" } },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(watch).toHaveBeenLastCalledWith(["lease-runner"]);
      service.observeJobs([
        { leaseId: "lease-runner", job: { ...job, status: "completed", conclusion, updatedAt: 2 } },
      ]);
      expect(activity()).toMatchObject({
        status,
        message: status === "failed" ? "Runner cleanup failed." : "Runner finished.",
        subject: {
          type: "runner",
          actualJob: {
            jobId: 99,
            runId: 2,
            name: "Actual build",
            workflowName: "CI",
            htmlUrl: job.htmlUrl,
            status: "completed",
            conclusion,
          },
        },
      });
      if (requestedId === undefined) expect(activity()?.subject).not.toHaveProperty("requestedJob");
      else expect(activity()?.subject).toHaveProperty("requestedJob", { jobId: requestedId });
      await vi.advanceTimersByTimeAsync(1000);
      expect(watch).toHaveBeenLastCalledWith([]);
      service.observeJobs([{ leaseId: "lease-runner", job }]);
      expect(activity()?.subject).toHaveProperty("actualJob.status", "completed");
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("lease watching is coalesced, bounded, expires idle observations and releases its timer", async () => {
  vi.useFakeTimers();
  const home = await mkdtemp(join(tmpdir(), "vectis-job-watch-"));
  const store = new Store(join(home, "state.sqlite"));
  const watch = vi.fn();
  const service = new Service(
    store,
    new VmRuntime({ home }),
    undefined,
    undefined,
    undefined,
    watch,
  );
  try {
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    seed(store, "old", "succeeded");
    store.updateActivity("old", (base) => ({ ...base, createdAt: old }));
    const missing = seed(store, "missing", "running");
    store.update(missing, {
      result: {
        bindingId: "binding",
        environmentId: "linux",
        leaseKey: "missing",
        stage: "starting",
      },
    });
    seed(store, "completed", "succeeded");
    service.observeJobs([{ leaseId: "lease-completed", job: { ...job, status: "completed" } }]);
    for (let index = 0; index < 22; index++) {
      seed(store, `runner${index}`, "succeeded");
      store.updateActivity(`runner${index}`, (base) => ({
        ...base,
        createdAt: new Date(Date.now() - (22 - index) * 1000).toISOString(),
      }));
    }
    expect(watch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenLastCalledWith(
      Array.from({ length: 20 }, (_, index) => `lease-runner${21 - index}`),
    );
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(watch).toHaveBeenLastCalledWith([]);
    await service.close();
    watch.mockClear();
    store.touch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
