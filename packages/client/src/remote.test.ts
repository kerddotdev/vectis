import { expect, test, vi } from "vitest";
import { ControllerClient } from "./controller.js";
import { RemoteClient } from "./remote.js";
import type { ActivityDetail } from "../../protocol/src/index.js";
import type { RunnerProgress } from "../../protocol/src/runners.js";

function fixture() {
  const controller = new ControllerClient(
    {
      deploymentUrl: "https://isolated-test.convex.cloud",
      controllerId: "controller1",
      expiresAt: Date.now() + 100000,
    },
    { get: async () => "unused-test-secret" },
  );
  return {
    request: vi.spyOn(controller, "request"),
    client: new RemoteClient(controller, "machine1"),
  };
}
const record = {
  _id: "remote1",
  machineId: "machine1",
  key: "stable",
  commandJson: '{"type":"machine.pause","paused":true}',
  phase: "accepted",
  createdAt: 1000,
  updatedAt: 1000,
};

test("remote detail and activity-list reads submit targeted inspections instead of status", async () => {
  const { request, client } = fixture();
  const result: RunnerProgress = {
    bindingId: "binding",
    environmentId: "linux",
    leaseKey: "local-operation",
    stage: "finished",
    phases: [{ name: "vm_start", startedAt: "2026-01-01", endedAt: "2026-01-01" }],
  };
  const detail: ActivityDetail = {
    activity: {
      id: "activity",
      kind: "vectis",
      subject: { type: "command", command: "runner.run" },
      rootOperationId: "local-operation",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      status: "succeeded",
      message: "Done",
    },
    operations: [
      {
        id: "local-operation",
        key: "local-key",
        command: "runner.run",
        result,
        activityId: "activity",
        status: "succeeded",
        message: "Done",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
  };
  const cases = [
    {
      query: { name: "activity", id: "activity" },
      result: detail,
      read: () => client.activity("activity"),
    },
    { query: { name: "activities" }, result: [detail.activity], read: () => client.activities() },
    {
      query: { name: "operation", id: "local-operation" },
      result: detail.operations[0],
      read: () => client.localOperation("local-operation"),
    },
    {
      query: { name: "operation.key", key: "local-key" },
      result: detail.operations[0],
      read: () => client.operationByKey("local-key"),
    },
  ];
  for (const { query, result, read } of cases) {
    request.mockClear();
    request.mockResolvedValueOnce({ queryId: "query" }).mockResolvedValueOnce({
      pending: false,
      responseJson: JSON.stringify({ ok: true, result }),
    });
    expect(await read()).toEqual(result);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ type: "query.submit", query });
  }
});
test("activity cancellation is replayed on the machine with the local activity identity", async () => {
  const { request, client } = fixture();
  const command = { type: "activity.cancel", id: "local-activity" } as const;
  request
    .mockResolvedValueOnce({ operationId: "remote1" })
    .mockResolvedValueOnce({ ...record, commandJson: JSON.stringify(command) });
  expect(await client.submit(command, "cancel-activity")).toMatchObject({
    status: "accepted",
    command: "activity.cancel",
  });
  expect(request.mock.calls[0]?.[0]).toEqual({
    type: "operation.submit",
    machineId: "machine1",
    key: "cancel-activity",
    command,
  });
});
test.each(["succeeded", "failed", "cancelled", "action_required"])(
  "settle follows a queued remote command to %s without treating failure as a submit error",
  async (phase) => {
    const { request, client } = fixture();
    request
      .mockResolvedValueOnce({ operationId: "remote1" })
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, phase });
    expect(await client.settle({ type: "machine.pause", paused: true }, "stable")).toMatchObject({
      id: "remote1",
      key: "stable",
      status: phase,
    });
    expect(request.mock.calls[0]?.[0]).toEqual({
      type: "operation.submit",
      machineId: "machine1",
      key: "stable",
      command: { type: "machine.pause", paused: true },
    });
  },
);
test("settle propagates remote submission rejection and times out without cancelling execution", async () => {
  const { request, client } = fixture();
  const error = new Error("Submission rejected");
  request.mockRejectedValueOnce(error);
  await expect(client.settle({ type: "machine.pause", paused: true }, "stable")).rejects.toBe(
    error,
  );
  request.mockClear();
  request.mockResolvedValueOnce({ operationId: "remote1" }).mockResolvedValue(record);
  await expect(
    client.settle({ type: "machine.pause", paused: true }, "stable", AbortSignal.timeout(50)),
  ).rejects.toMatchObject({ code: "wait_cancelled" });
  expect(request.mock.calls.some(([command]) => command.type === "operation.cancel")).toBe(false);
});
test("queued remote commands do not report success and cancellation stays on the remote target", async () => {
  const { request, client } = fixture();
  request.mockResolvedValueOnce({ operationId: "remote1" }).mockResolvedValueOnce(record);
  expect(await client.submit({ type: "machine.pause", paused: true }, "stable")).toMatchObject({
    id: "remote1",
    status: "accepted",
    result: { remotePhase: "accepted" },
  });
  request
    .mockResolvedValueOnce(record)
    .mockResolvedValueOnce({ operationId: "remote1" })
    .mockResolvedValueOnce({ ...record, phase: "cancelled" });
  expect(await client.submit({ type: "operation.cancel", id: "remote1" }, "cancel")).toMatchObject({
    status: "cancelled",
    message: "Cancelled before execution.",
  });
  expect(request).toHaveBeenCalledWith({ type: "operation.cancel", id: "remote1" }, undefined);
});
test("operation lookup rejects another machine and cancelled waiting does not cancel execution", async () => {
  const { request, client } = fixture();
  request.mockResolvedValueOnce({ ...record, machineId: "other" });
  await expect(client.operation("remote1")).rejects.toMatchObject({ code: "operation_missing" });
  request.mockClear();
  await expect(client.wait("remote1", AbortSignal.abort())).rejects.toMatchObject({
    code: "wait_cancelled",
  });
  expect(request).not.toHaveBeenCalled();
});
test("remote capability discovery uses a fresh inspection and completed operations return local details", async () => {
  const { request, client } = fixture();
  request.mockResolvedValueOnce({ queryId: "query1" }).mockResolvedValueOnce({
    pending: false,
    responseJson: '{"ok":true,"result":{"protocolVersion":1}}',
  });
  expect(await client.capabilities()).toEqual({ protocolVersion: 1 });
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "query.submit",
    machineId: "machine1",
    query: { name: "capabilities" },
  });
  request
    .mockResolvedValueOnce({
      ...record,
      phase: "succeeded",
      resultJson: JSON.stringify({
        message: "Done",
        operationId: "local1",
        resultAvailableLocally: true,
      }),
    })
    .mockResolvedValueOnce({ queryId: "query2" })
    .mockResolvedValueOnce({
      pending: false,
      responseJson: JSON.stringify({
        ok: true,
        result: {
          id: "local1",
          key: "remote:remote1",
          command: "machine.pause",
          status: "succeeded",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          message: "Done",
          result: { verified: true },
        },
      }),
    });
  expect(await client.operation("remote1")).toMatchObject({
    id: "remote1",
    status: "succeeded",
    result: { verified: true },
  });
});

test("a remotely replayed idle drain preserves its cancelled outcome and local result code", async () => {
  const { request, client } = fixture();
  const message = "The idle runner's VM was released.";
  request
    .mockResolvedValueOnce({
      ...record,
      commandJson: JSON.stringify({ type: "runner.run", bindingId: "binding", jobId: 1 }),
      phase: "cancelled",
      resultJson: JSON.stringify({ message, operationId: "local1", resultAvailableLocally: true }),
    })
    .mockResolvedValueOnce({ queryId: "query1" })
    .mockResolvedValueOnce({
      pending: false,
      responseJson: JSON.stringify({
        ok: true,
        result: {
          id: "local1",
          key: "remote:remote1",
          command: "runner.run",
          status: "cancelled",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
          message,
          result: { code: "runner_idle", stage: "finished", leaseId: "lease" },
        },
      }),
    });
  expect(await client.operation("remote1")).toMatchObject({
    status: "cancelled",
    message,
    result: { code: "runner_idle", leaseId: "lease" },
  });
  expect(request.mock.calls[1]?.[0]).toMatchObject({
    type: "query.submit",
    query: { name: "operation", id: "local1" },
  });
});

test.each(["machine_offline", "claim_timeout"])(
  "a request expired before claim exposes %s without querying the host",
  async (code) => {
    const { request, client } = fixture();
    const message =
      code === "machine_offline"
        ? "The machine went offline before it claimed this runner request."
        : "The machine did not claim this runner request within ten minutes.";
    request.mockResolvedValueOnce({
      ...record,
      commandJson: JSON.stringify({
        type: "runner.run",
        bindingId: "binding",
        jobId: 4,
        automatic: true,
      }),
      phase: "cancelled",
      resultJson: JSON.stringify({
        status: "cancelled",
        code,
        message,
        resultAvailableLocally: false,
      }),
    });
    expect(await client.operation("remote1")).toMatchObject({
      status: "cancelled",
      message,
      result: { remotePhase: "cancelled", code, resultAvailableLocally: false },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { type: "operation.get", id: "remote1" },
      undefined,
    );
  },
);

test.each(["rosetta", "off"] as const)(
  "remote environment configuration retains x64=%s",
  async (x64) => {
    const { request, client } = fixture();
    const command = { type: "environment.configure", id: "linux", x64 } as const;
    request
      .mockResolvedValueOnce({ operationId: "remote1" })
      .mockResolvedValueOnce({ ...record, commandJson: JSON.stringify(command) });
    expect(await client.submit(command, "x64")).toMatchObject({
      status: "accepted",
      command: "environment.configure",
    });
    expect(request.mock.calls[0]?.[0]).toEqual({
      type: "operation.submit",
      machineId: "machine1",
      key: "x64",
      command,
    });
  },
);

test("remote status preserves effective environment egress", async () => {
  const { request, client } = fixture();
  request.mockResolvedValueOnce({ queryId: "egress-status" }).mockResolvedValueOnce({
    pending: false,
    responseJson: JSON.stringify({
      ok: true,
      result: {
        protocolVersion: 1,
        machine: { id: "machine1", name: "Host", paused: false },
        environments: [
          {
            id: "windows",
            name: "Windows",
            os: "windows",
            state: "ready",
            basePath: "/synthetic/base.img",
            cpu: 1,
            memoryMiB: 512,
            network: { egress: "internet_only", enforcement: "enforced" },
          },
        ],
        instances: [],
        operations: [],
      },
    }),
  });
  expect((await client.status()).environments[0]?.network).toEqual({
    egress: "internet_only",
    enforcement: "enforced",
  });
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "query.submit",
    machineId: "machine1",
    query: { name: "status" },
  });
});

test("job logs use a controller LocalQuery and carry the cursor and coded errors", async () => {
  const { request, client } = fixture();
  const result = {
    text: "failure\n",
    next: 108,
    status: "completed",
    complete: true,
    truncated: false,
  };
  request
    .mockResolvedValueOnce({ queryId: "query1" })
    .mockResolvedValueOnce({ pending: false, responseJson: JSON.stringify({ ok: true, result }) });
  expect(await client.jobLogs({ bindingId: "binding1", jobId: 4, after: 100 })).toEqual(result);
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "query.submit",
    machineId: "machine1",
    query: { name: "job.logs", bindingId: "binding1", jobId: 4, after: 100 },
  });
  request.mockResolvedValueOnce({ queryId: "query2" }).mockResolvedValueOnce({
    pending: false,
    responseJson: JSON.stringify({
      ok: false,
      code: "repository_access_denied",
      message: "Denied.",
      nextStep: "Check the binding.",
    }),
  });
  await expect(client.jobLogs({ bindingId: "other", jobId: 4 })).rejects.toMatchObject({
    code: "repository_access_denied",
  });
  request.mockClear();
  await expect(client.jobLogs({ bindingId: "binding1", jobId: 4, after: -1 })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

test("remote readiness sends a read inspection and validates the returned checks", async () => {
  const { request, client } = fixture();
  const report = {
    ready: false,
    checks: [
      {
        id: "github.app",
        status: "blocked",
        code: "github_app_not_installed",
        message: "Install the App.",
        nextStep: "Open GitHub.",
        target: { area: "github" },
      },
    ],
  };
  request.mockResolvedValueOnce({ queryId: "query1" }).mockResolvedValueOnce({
    pending: false,
    responseJson: JSON.stringify({ ok: true, result: report }),
  });
  expect(await client.repositoryReadiness({ bindingId: "binding1" })).toEqual(report);
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "query.submit",
    machineId: "machine1",
    query: { name: "repository.readiness", input: { bindingId: "binding1" } },
  });
  request.mockResolvedValueOnce({ queryId: "query2" }).mockResolvedValueOnce({
    pending: false,
    responseJson: JSON.stringify({
      ok: true,
      result: {
        ready: true,
        checks: [{ id: "github.app", status: "invented", message: "Invalid" }],
      },
    }),
  });
  await expect(
    client.repositoryReadiness({ repositoryName: "owner/repo", environmentId: "linux" }),
  ).rejects.toThrow();
});

test.each([false, true])(
  "remote readiness checks capabilities after an ambiguous inspection failure (supported: %s)",
  async (supported) => {
    const { request, client } = fixture();
    const failure = {
      ok: false,
      code: "inspection_failed",
      message: "The local inspection could not be completed.",
      nextStep: "Retry the inspection.",
    };
    request
      .mockResolvedValueOnce({ queryId: "query1" })
      .mockResolvedValueOnce({ pending: false, responseJson: JSON.stringify(failure) })
      .mockResolvedValueOnce({ queryId: "query2" })
      .mockResolvedValueOnce({
        pending: false,
        responseJson: JSON.stringify({
          ok: true,
          result: {
            protocolVersion: 1,
            capabilities: supported
              ? [{ name: "repository.readiness", kind: "query" }]
              : [{ name: "doctor", kind: "query" }],
          },
        }),
      });
    await expect(client.repositoryReadiness({ bindingId: "binding1" })).rejects.toMatchObject(
      supported
        ? { code: failure.code, message: failure.message }
        : {
            code: "unknown_query",
            message: "Repository readiness is unavailable on this machine.",
          },
    );
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      query: { name: "capabilities" },
      machineId: "machine1",
    });
  },
);

test("remote readiness preserves the original failure when capability discovery fails", async () => {
  const { request, client } = fixture();
  request
    .mockResolvedValueOnce({ queryId: "query1" })
    .mockResolvedValueOnce({
      pending: false,
      responseJson: JSON.stringify({
        ok: false,
        code: "inspection_failed",
        message: "The original inspection failed.",
        nextStep: "Retry the inspection.",
      }),
    })
    .mockRejectedValueOnce(new Error("Capability discovery failed."));
  await expect(client.repositoryReadiness({ bindingId: "binding1" })).rejects.toMatchObject({
    code: "inspection_failed",
    message: "The original inspection failed.",
  });
});

test.each([
  { type: "repository.cache", bindingId: "binding", enabled: true, sizeGiB: 30 },
  { type: "repository.cache", bindingId: "binding", enabled: false },
  { type: "cache.clear", bindingId: "binding" },
] as const)(
  "remote $type preserves the binding settings and local operation contract",
  async (command) => {
    const { request, client } = fixture();
    request
      .mockResolvedValueOnce({ operationId: "remote1" })
      .mockResolvedValueOnce({ ...record, commandJson: JSON.stringify(command) });
    expect(await client.submit(command, "cache")).toMatchObject({
      status: "accepted",
      command: command.type,
    });
    expect(request.mock.calls[0]?.[0]).toEqual({
      type: "operation.submit",
      machineId: "machine1",
      key: "cache",
      command,
    });
  },
);
