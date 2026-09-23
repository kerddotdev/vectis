import { expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { VectisError } from "../../../packages/protocol/src/index.js";
import { activityFor } from "./activities.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-operation-close-"));
  homes.push(home);
  const store = new Store(":memory:");
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
      labels: [],
      status: "completed" as const,
      conclusion: "success",
    })),
    findRunner: vi.fn(async () => null),
    prepareRunner: vi.fn(),
    releaseRunner: vi.fn(async () => {}),
    repositories: async () => [],
  };
  const service = new Service(store, new VmRuntime({ home }), () => broker);
  const status = (id: string) => store.snapshot().operations.find((item) => item.id === id);
  return { store, service, broker, status };
}

test("an operation left waiting by a restart can be closed", async () => {
  const { store, service, status } = await fixture();
  try {
    const stranded = store.accept("scan", "fingerprint", "job.scan").operation;
    store.update(stranded, { status: "running" });
    store.recover();
    expect(status(stranded.id)?.status).toBe("action_required");
    const close = service.submit("close", { type: "operation.cancel", id: stranded.id });
    await service.drain();
    expect(status(close.id)?.status).toBe("succeeded");
    expect(status(stranded.id)?.status).toBe("cancelled");
  } finally {
    await service.close();
    store.close();
  }
});

test("closing never replaces reconciliation or preparation recovery", async () => {
  const { store, service, status } = await fixture();
  try {
    const runner = store.accept("runner", "fingerprint", "runner.run").operation;
    store.update(runner, {
      status: "action_required",
      result: { bindingId: "binding", environmentId: "test", leaseKey: runner.id },
    });
    const preparation = store.accept("linux", "fingerprint", "environment.prepare-linux").operation;
    store.update(preparation, { status: "action_required", result: { setupId: "setup" } });
    for (const waiting of [runner, preparation]) {
      const close = service.submit(`close:${waiting.id}`, {
        type: "operation.cancel",
        id: waiting.id,
      });
      await service.drain();
      expect(status(close.id)?.status).toBe("failed");
      expect(status(close.id)?.result).toMatchObject({ code: "operation_not_cancellable" });
      expect(status(waiting.id)?.status).toBe("action_required");
    }
  } finally {
    await service.close();
    store.close();
  }
});

test("a refused repository connection fails with its cause instead of waiting forever", async () => {
  const { store, service, broker, status } = await fixture();
  try {
    store.put("environment", "test", {
      id: "test",
      name: "Test",
      os: "linux",
      basePath: "/unused",
      cpu: 2,
      memoryMiB: 2048,
      state: "ready",
    });
    broker.connectRepository.mockRejectedValue(
      new VectisError(
        "github_app_not_installed",
        "GitHub has no active Vectis installation for owner/repo that the verified account can use.",
        "Install the Vectis GitHub App on the owner, then retry.",
      ),
    );
    const operation = service.submit("connect", {
      type: "repository.connect",
      accountId: "account",
      repositoryName: "repo",
      environmentId: "test",
    });
    await service.drain();
    await vi.waitFor(() => expect(status(operation.id)?.status).toBe("failed"));
    expect(status(operation.id)?.result).toMatchObject({ code: "github_app_not_installed" });
  } finally {
    await service.close();
    store.close();
  }
});

test("activity cancellation preserves setup ownership and runner reconciliation, but closes a waiting connection", async () => {
  const { store, service, status } = await fixture();
  try {
    const commands = [
      { type: "environment.resume-macos", id: "setup" },
      { type: "runner.run", bindingId: "binding" },
      {
        type: "repository.connect",
        accountId: "account",
        repositoryName: "repo",
        environmentId: "image",
      },
    ] as const;
    for (const command of commands) {
      const id = command.type;
      const link = activityFor(id, command);
      const waiting = store.accept(id, id, command.type, link, id).operation;
      store.update(waiting, {
        status: "action_required",
        ...(command.type === "environment.resume-macos" ? { result: { setupId: "setup" } } : {}),
      });
      const close = service.submit(`close:${id}`, {
        type: "activity.cancel",
        id: link?.activityId ?? id,
      });
      await service.drain();
      const closable = command.type === "repository.connect";
      expect(status(close.id)?.status).toBe(closable ? "succeeded" : "failed");
      expect(status(waiting.id)?.status).toBe(closable ? "cancelled" : "action_required");
      expect(
        store.snapshot().activities?.find((activity) => activity.id === link?.activityId)?.status,
      ).toBe(closable ? "cancelled" : "action_required");
      if (!closable)
        expect(status(close.id)?.result).toMatchObject({ code: "operation_not_cancellable" });
      else expect(status(waiting.id)?.message).toBe("Closed without confirming its result.");
      expect(status(close.id)?.activityId).toBeUndefined();
    }
    const closedAgain = service.submit("close-again", {
      type: "activity.cancel",
      id: "repository.connect",
    });
    await service.drain();
    expect(status(closedAgain.id)?.result).toMatchObject({ code: "operation_not_cancellable" });
  } finally {
    await service.close();
    store.close();
  }
});
