import { expect, test, vi } from "vitest";
import { ControllerClient } from "./controller.js";
import { RemoteClient } from "./remote.js";

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
