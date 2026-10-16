import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ScaleSetListener } from "./scale-set-listener.js";
import { Store } from "./store.js";
import { ScaleSetHttpError, type Message } from "../../../packages/scaleset/src/index.js";
import type { ScaleSetGrant } from "../../../packages/protocol/src/scale-sets.js";
import { VectisError, type Command } from "../../../packages/protocol/src/index.js";
import type { MachineRepositories } from "../../../packages/protocol/src/repositories.js";

const grant: ScaleSetGrant = {
  bindingId: "binding",
  generation: 1,
  scaleSetId: 42,
  scaleSetName: "vectis-linux",
  sessionId: "00000000-0000-4000-8000-000000000001",
  messageQueueUrl: "https://queue.example.test/messages",
  messageQueueAccessToken: "private-queue-token",
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function waitForAbort(signal: AbortSignal) {
  return new Promise<null>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  });
}
const message = (id: number, assigned: number): Message => ({
  messageId: id,
  statistics: { totalAssignedJobs: assigned },
  jobs: [{ messageType: "JobAssigned" }],
});
async function fixture(capacity = 4, realTransport = false) {
  const home = await mkdtemp(join(tmpdir(), "vectis-scale-set-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "state.sqlite"));
  cleanup.push(async () => store.close());
  let bindings: MachineRepositories = [
    {
      id: "binding",
      repositoryId: 1,
      repositoryName: "test/repo",
      environmentId: "linux",
      automatic: true,
      capacityMode: "scale_set",
    },
  ];
  let connected = true;
  const broker = {
    openScaleSet: vi.fn(async () => grant),
    refreshScaleSet: vi.fn(async () => ({ ...grant, messageQueueAccessToken: "renewed-token" })),
    closeScaleSet: vi.fn(async () => {}),
  };
  const client = {
    getMessage: vi.fn<
      (last: number, capacity: number, signal: AbortSignal) => Promise<Message | null>
    >(async (_last, _capacity, signal) => waitForAbort(signal)),
    acknowledgeMessage: vi.fn(async (_id: number, _signal: AbortSignal) => {}),
    acquireJobs: vi.fn(async (ids: readonly number[], _signal: AbortSignal, _url?: string) => ids),
  };
  const submit = vi.fn(
    (key: string, command: Command) =>
      store.accept(key, JSON.stringify(command), command.type).operation,
  );
  const create = () => {
    const listener = new ScaleSetListener({
      store,
      broker: () => broker,
      repositories: () => bindings,
      connected: () => connected,
      snapshot: () => {
        const snapshot = store.snapshot();
        const active = snapshot.operations.filter(
          (op) => ["accepted", "running"].includes(op.status) && op.command === "runner.run",
        ).length;
        return {
          ...snapshot,
          runnerCapacity: {
            max: capacity,
            active,
            available: capacity - active,
            environments: [{ environmentId: "linux", available: Math.max(0, capacity - active) }],
          },
        };
      },
      submit,
      ...(realTransport
        ? {}
        : {
            sessionClient: (value: ScaleSetGrant) => {
              grants.push(value);
              return client;
            },
          }),
      random: () => 0,
    });
    cleanup.push(() => listener.close());
    return listener;
  };
  const grants: ScaleSetGrant[] = [];
  const listener = create();
  return {
    store,
    broker,
    client,
    listener,
    submit,
    grants,
    create,
    setBindings: (value: MachineRepositories) => {
      bindings = value;
      store.touch();
    },
    disconnect: () => {
      connected = false;
      store.touch();
    },
    pause: () => {
      store.put("machine", "self", { ...store.snapshot().machine, paused: true });
    },
  };
}

test("opens one session, accepts exactly the missing capacity and acknowledges after durable acceptance", async () => {
  const f = await fixture(3);
  f.client.getMessage
    .mockResolvedValueOnce(message(1, 5))
    .mockResolvedValueOnce(message(1, 5))
    .mockResolvedValueOnce(message(2, 5));
  f.client.acknowledgeMessage.mockImplementation(async () => {
    expect(f.store.snapshot().operations).toHaveLength(3);
    expect(
      f.store.snapshot().operations.every((operation) => operation.status === "accepted"),
    ).toBe(true);
  });
  f.listener.start();
  await vi.waitFor(() => expect(f.client.acknowledgeMessage).toHaveBeenCalledTimes(3));
  expect(f.broker.openScaleSet).toHaveBeenCalledOnce();
  expect(f.submit).toHaveBeenCalledTimes(3);
  expect(f.submit.mock.calls.map((call) => call[0])).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/:1:1$/),
      expect.stringMatching(/:1:2$/),
      expect.stringMatching(/:1:3$/),
    ]),
  );
  expect(
    f.submit.mock.calls.every(
      (call) =>
        JSON.stringify(call[1]) ===
        JSON.stringify({
          type: "runner.run",
          bindingId: "binding",
          automatic: true,
          scaleSet: { generation: 1 },
        }),
    ),
  ).toBe(true);
  expect(f.listener.states()).toMatchObject([
    { state: "listening", assignedJobs: 5, reservedRunners: 3 },
  ]);
  expect(JSON.stringify(f.listener.states())).not.toContain("private-queue-token");
  expect(f.client.getMessage.mock.calls[1]?.slice(0, 2)).toEqual([1, 3]);
});

test("an acknowledged level can fill slots that become free on an empty poll", async () => {
  const f = await fixture(2);
  const other = f.store.accept("other", "other", "runner.run").operation;
  f.client.getMessage.mockResolvedValueOnce(message(1, 2)).mockImplementationOnce(async () => {
    f.store.update(other, { status: "succeeded" });
    return null;
  });
  f.listener.start();
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
  expect(f.listener.states()).toMatchObject([{ reservedRunners: 2 }]);
});

test("replays a persisted partial plan with the original keys without duplicating accepted operations", async () => {
  const f = await fixture(3);
  const submit = f.submit.getMockImplementation();
  if (!submit) throw new Error("Missing fixture submit.");
  let accepted = 0;
  f.submit.mockImplementation((key, command) => {
    if (++accepted === 2) throw new Error("simulated interruption");
    return submit(key, command);
  });
  f.client.getMessage.mockResolvedValueOnce(message(1, 3));
  f.listener.start();
  await vi.waitFor(() => expect(f.listener.states()[0]?.state).toBe("action_required"));
  expect(f.client.acknowledgeMessage).not.toHaveBeenCalled();
  expect(f.store.snapshot().operations).toHaveLength(1);
  await f.listener.close();
  f.submit.mockImplementation(submit);
  const restarted = f.create();
  f.client.getMessage.mockResolvedValueOnce(message(1, 3));
  restarted.start();
  await vi.waitFor(() => expect(f.client.acknowledgeMessage).toHaveBeenCalledOnce());
  expect(f.store.snapshot().operations).toHaveLength(3);
  expect(new Set(f.store.snapshot().operations.map((operation) => operation.key)).size).toBe(3);
});

test("401 refreshes the queue grant once and replays the poll with the same cursor", async () => {
  const f = await fixture();
  f.client.getMessage
    .mockRejectedValueOnce(new ScaleSetHttpError(401, null, true))
    .mockResolvedValueOnce(message(1, 1));
  f.listener.start();
  await vi.waitFor(() => expect(f.client.acknowledgeMessage).toHaveBeenCalledOnce());
  expect(f.broker.refreshScaleSet).toHaveBeenCalledExactlyOnceWith(
    "binding",
    1,
    expect.any(AbortSignal),
  );
  expect(f.grants.map((grant) => grant.messageQueueAccessToken)).toEqual([
    "private-queue-token",
    "renewed-token",
  ]);
  expect(f.client.getMessage.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([0, 0]);
});

test("a second 401 on the same request stops with an honest auth error", async () => {
  const f = await fixture();
  f.client.getMessage.mockRejectedValue(new ScaleSetHttpError(401, null, true));
  f.listener.start();
  await vi.waitFor(() =>
    expect(f.listener.states()).toMatchObject([
      { state: "action_required", code: "scale_set_auth_failed" },
    ]),
  );
  expect(f.broker.refreshScaleSet).toHaveBeenCalledOnce();
  expect(f.broker.closeScaleSet).toHaveBeenCalledOnce();
});

test("JobAvailable retries acquisition with the same positive IDs, while JobAssigned needs none", async () => {
  const f = await fixture();
  f.client.getMessage.mockResolvedValueOnce({
    ...message(1, 1),
    jobs: [
      {
        messageType: "JobAvailable",
        runnerRequestId: 7,
        acquireJobUrl: "https://actions.test/_apis/runtime/runnerscalesets/42/acquirejobs",
      },
      { messageType: "JobAssigned" },
    ],
  });
  f.client.acquireJobs.mockRejectedValueOnce(new ScaleSetHttpError(401, null, true));
  f.listener.start();
  await vi.waitFor(() => expect(f.client.acknowledgeMessage).toHaveBeenCalledOnce());
  expect(f.client.acquireJobs.mock.calls.map((call) => call[0])).toEqual([[7], [7]]);
  expect(f.broker.refreshScaleSet).toHaveBeenCalledOnce();
  expect(f.submit).toHaveBeenCalledOnce();
});

test("409 exposes session conflict without opening another session or accepting work", async () => {
  const f = await fixture();
  f.broker.openScaleSet.mockRejectedValue(new ScaleSetHttpError(409, null, false));
  f.listener.start();
  await vi.waitFor(() =>
    expect(f.listener.states()).toMatchObject([
      { state: "action_required", code: "scale_set_session_conflict" },
    ]),
  );
  f.store.touch();
  await Promise.resolve();
  expect(f.broker.openScaleSet).toHaveBeenCalledOnce();
  expect(f.submit).not.toHaveBeenCalled();
});

test.each(["pause", "disable", "mode", "disconnect", "shutdown"] as const)(
  "%s aborts the outstanding poll and closes the owned session",
  async (action) => {
    const f = await fixture();
    f.listener.start();
    await vi.waitFor(() => expect(f.client.getMessage).toHaveBeenCalledOnce());
    const signal = f.client.getMessage.mock.calls[0]?.[2];
    if (action === "pause") f.pause();
    else if (action === "disconnect") f.disconnect();
    else if (action === "shutdown") await f.listener.close();
    else
      f.setBindings([
        {
          id: "binding",
          repositoryId: 1,
          repositoryName: "test/repo",
          environmentId: "linux",
          automatic: action !== "disable",
          capacityMode: action === "mode" ? "demand" : "scale_set",
        },
      ]);
    await vi.waitFor(() =>
      expect(f.broker.closeScaleSet).toHaveBeenCalledExactlyOnceWith(
        "binding",
        1,
        expect.any(AbortSignal),
      ),
    );
    expect(signal?.aborted).toBe(true);
    expect(f.broker.openScaleSet).toHaveBeenCalledOnce();
  },
);

test("restrictive policy fails closed before session opening and retries only after a binding change", async () => {
  const f = await fixture();
  const binding = {
    id: "binding",
    repositoryId: 1,
    repositoryName: "test/repo",
    environmentId: "linux",
    automatic: true,
    capacityMode: "scale_set" as const,
  };
  f.setBindings([{ ...binding, access: { actors: "any", approval: "required" } }]);
  f.listener.start();
  await vi.waitFor(() =>
    expect(f.listener.states()).toMatchObject([
      { state: "action_required", code: "scale_set_policy_unsupported" },
    ]),
  );
  expect(f.broker.openScaleSet).not.toHaveBeenCalled();
  f.setBindings([binding]);
  await vi.waitFor(() => expect(f.client.getMessage).toHaveBeenCalledOnce());
});

test("Retry-After and backoff are abortable and do not create overlapping polls", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.client.getMessage.mockRejectedValueOnce(new ScaleSetHttpError(429, "5", true));
  f.listener.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.client.getMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.client.getMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.client.getMessage).toHaveBeenCalledTimes(2);
  await f.listener.close();
  expect(f.broker.closeScaleSet).toHaveBeenCalledOnce();
});

test("cloud authorization errors retain their code without exposing credentials", async () => {
  const f = await fixture();
  f.broker.openScaleSet.mockRejectedValue(new VectisError("machine_revoked", "revoked"));
  f.listener.start();
  await vi.waitFor(() =>
    expect(f.listener.states()).toMatchObject([
      { state: "action_required", code: "machine_revoked" },
    ]),
  );
});

test.each([false, true])(
  "the real queue transport decodes zero-ID assignment and uses only the queue token (acquire=%s)",
  async (acquire) => {
    const f = await fixture(2, true);
    let polls = 0;
    const requests: Array<{ url: URL; input: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, input: RequestInit) => {
        requests.push({ url, input });
        if (input.method === "GET") {
          if (++polls > 1) {
            const signal = input.signal;
            if (!signal) throw new Error("Missing poll signal.");
            await waitForAbort(signal);
            throw new Error("Poll aborted.");
          }
          return Response.json({
            messageId: 1,
            messageType: "RunnerScaleSetJobMessages",
            statistics: { totalAssignedJobs: 2 },
            body: JSON.stringify([
              { messageType: "JobAssigned", runnerRequestId: 0 },
              ...(acquire
                ? [
                    {
                      messageType: "JobAvailable",
                      runnerRequestId: 7,
                      acquireJobUrl:
                        "https://queue.example.test/_apis/runtime/runnerScaleSets/42/acquirejobs",
                    },
                  ]
                : []),
            ]),
          });
        }
        if (input.method === "POST") return Response.json({ count: 1, value: [7] });
        expect(input.method).toBe("DELETE");
        expect(f.store.snapshot().operations).toHaveLength(2);
        return new Response(null, { status: 204 });
      }),
    );
    f.listener.start();
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.input.method === "DELETE")).toHaveLength(1),
    );
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(
      requests.every(
        (request) =>
          new Headers(request.input.headers).get("Authorization") === "Bearer private-queue-token",
      ),
    ).toBe(true);
    const acquired = requests.filter((request) => request.input.method === "POST");
    expect(acquired).toHaveLength(acquire ? 1 : 0);
    if (acquire) {
      expect(acquired[0]?.url.pathname).toBe("/_apis/runtime/runnerscalesets/42/acquirejobs");
      expect(acquired[0]?.input.body).toBe("[7]");
    }
  },
);

test("snapshot reservation counts stay current while a long poll is outstanding", async () => {
  const f = await fixture();
  f.client.getMessage.mockResolvedValueOnce(message(1, 2));
  f.listener.start();
  await vi.waitFor(() => expect(f.client.acknowledgeMessage).toHaveBeenCalledOnce());
  const operation = f.store.snapshot().operations[0];
  if (!operation) throw new Error("Missing accepted runner.");
  f.store.update(operation, { status: "succeeded" });
  const revision = f.store.snapshot().revision;
  expect(f.listener.states()).toMatchObject([{ reservedRunners: 1 }]);
  expect(f.store.snapshot().revision).toBe(revision);
});
