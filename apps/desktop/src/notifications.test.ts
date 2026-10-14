import { afterEach, expect, test, vi } from "vitest";
import type { Activity, Snapshot } from "../../../packages/protocol/src/index.js";
import { activityTransitions, NotificationPoller } from "./notifications.js";

function activity(
  id: string,
  status: Activity["status"],
  createdAt = "2026-10-14T10:00:00Z",
): Activity {
  return {
    id,
    kind: "vectis",
    subject: { type: "command", command: "repository.connect" },
    rootOperationId: `operation-${id}`,
    createdAt,
    updatedAt: createdAt,
    status,
    message: "Connect repository",
  };
}

function snapshot(activities: readonly Activity[], revision?: string): Snapshot {
  return {
    ...(revision !== undefined ? { revision } : {}),
    protocolVersion: 1,
    machine: { id: "local", name: "Synthetic Mac", paused: false },
    environments: [],
    instances: [],
    operations: [],
    activities,
  };
}

const pollers: NotificationPoller[] = [];
function pollerFor(initial: Snapshot) {
  let current = initial;
  let enabled = true;
  let focused = false;
  const client = { status: vi.fn(async (_signal?: AbortSignal) => current) };
  const connect = vi.fn(async () => client);
  const notify = vi.fn();
  const poller = new NotificationPoller({
    client: connect,
    enabled: () => enabled,
    focused: () => focused,
    notify,
  });
  pollers.push(poller);
  return {
    poller,
    client,
    connect,
    notify,
    snapshot: (value: Snapshot) => {
      current = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    focused: (value: boolean) => {
      focused = value;
    },
  };
}

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop();
  vi.useRealTimers();
});

test("the first snapshot establishes a baseline without replaying history", () => {
  const initial = [activity("needs-you", "action_required"), activity("failure", "failed")];
  const baseline = activityTransitions(undefined, initial);
  expect(baseline.notifications).toEqual([]);
  const running = activityTransitions(
    baseline.known,
    initial.map((item) => ({ ...item, status: "running" })),
  );
  expect(activityTransitions(running.known, initial).notifications).toEqual([]);
});

test.each(["action_required", "failed"] as const)("a new %s state is announced once", (status) => {
  const baseline = activityTransitions(undefined, [activity("work", "running")]);
  const target = activity("work", status);
  const changed = activityTransitions(baseline.known, [target]);
  expect(changed.notifications).toEqual([target]);
  expect(baseline.known.get("work")?.status).toBe("running");
  const repeated = activityTransitions(changed.known, [target]);
  expect(repeated.notifications).toEqual([]);
  const running = activityTransitions(repeated.known, [activity("work", "running")]);
  expect(activityTransitions(running.known, [target]).notifications).toEqual([]);
});

test("one activity can announce each target status, and newly observed activities are news", () => {
  const baseline = activityTransitions(undefined, []);
  const attention = activity("work", "action_required");
  const changed = activityTransitions(baseline.known, [attention]);
  expect(changed.notifications).toEqual([attention]);
  const failed = activity("work", "failed");
  expect(activityTransitions(changed.known, [failed]).notifications).toEqual([failed]);
});

test("disappearing activities are forgotten", () => {
  const baseline = activityTransitions(undefined, [activity("work", "action_required")]);
  const gone = activityTransitions(baseline.known, []);
  expect(gone.known.size).toBe(0);
  const returned = activity("work", "action_required");
  expect(activityTransitions(gone.known, [returned]).notifications).toEqual([returned]);
});

test("only the 500 newest IDs are retained, without replaying excluded history", () => {
  const history = Array.from({ length: 520 }, (_, index) =>
    activity(`work-${index}`, "running", new Date(index * 1000).toISOString()),
  );
  const baseline = activityTransitions(undefined, history.toReversed());
  expect(baseline.known.size).toBe(500);
  expect(baseline.known.has("work-19")).toBe(false);
  expect(baseline.known.has("work-20")).toBe(true);
  const failed = history.map((item) => ({ ...item, status: "failed" as const }));
  const changed = activityTransitions(baseline.known, failed);
  expect(changed.notifications).toHaveLength(500);
  expect(activityTransitions(changed.known, failed.toReversed()).notifications).toEqual([]);
});

test("the poller skips unchanged revisions and reads snapshots without revisions", async () => {
  vi.useFakeTimers();
  const work = activity("work", "running");
  const fake = pollerFor(snapshot([work], "1"));
  fake.poller.start();
  fake.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  fake.snapshot(snapshot([activity("work", "failed")], "1"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(fake.notify).not.toHaveBeenCalled();
  fake.snapshot(snapshot([activity("work", "failed")], "2"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(fake.notify).toHaveBeenCalledOnce();
  fake.snapshot(snapshot([activity("work", "action_required")]));
  await vi.advanceTimersByTimeAsync(5000);
  expect(fake.notify).toHaveBeenCalledTimes(2);
  expect(fake.client.status).toHaveBeenCalledTimes(4);
});

test("connection failures back off to 30 seconds and successful reads restore the interval", async () => {
  vi.useFakeTimers();
  const fake = pollerFor(snapshot([], "1"));
  fake.connect.mockRejectedValue(new Error("Service unavailable"));
  fake.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fake.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20000);
  expect(fake.connect).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fake.connect).toHaveBeenCalledTimes(4);
  fake.connect.mockResolvedValue(fake.client);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fake.client.status).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fake.client.status).toHaveBeenCalledTimes(2);
  expect(fake.notify).not.toHaveBeenCalled();
});

test("failed status reads recover without losing the last observed activity states", async () => {
  vi.useFakeTimers();
  const fake = pollerFor(snapshot([activity("work", "running")], "1"));
  fake.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  fake.client.status.mockRejectedValueOnce(new Error("Connection lost"));
  await vi.advanceTimersByTimeAsync(5000);
  fake.snapshot(snapshot([activity("work", "failed")], "2"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(fake.notify).toHaveBeenCalledOnce();
});

test.each(["focused", "disabled"] as const)(
  "%s transitions are consumed without a later backlog",
  async (mode) => {
    vi.useFakeTimers();
    const fake = pollerFor(snapshot([activity("work", "running")], "1"));
    fake.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "focused") fake.focused(true);
    else fake.enabled(false);
    fake.snapshot(snapshot([activity("work", "action_required")], "2"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.notify).not.toHaveBeenCalled();
    fake.focused(false);
    fake.enabled(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.notify).not.toHaveBeenCalled();
    fake.snapshot(snapshot([activity("work", "failed")], "3"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.notify).toHaveBeenCalledOnce();
  },
);

test("stop releases the pending timer and aborts an in-flight status read", async () => {
  vi.useFakeTimers();
  const fake = pollerFor(snapshot([], "1"));
  fake.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  let resolve: ((value: Snapshot) => void) | undefined;
  fake.client.status.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  const signal = fake.client.status.mock.calls[1]?.[0];
  expect(signal?.aborted).toBe(false);
  fake.poller.stop();
  expect(signal?.aborted).toBe(true);
  resolve?.(snapshot([activity("work", "failed")], "2"));
  await vi.advanceTimersByTimeAsync(30000);
  expect(fake.notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(fake.client.status).toHaveBeenCalledTimes(2);
});

test("stopping before a connection resolves prevents a status request", async () => {
  vi.useFakeTimers();
  const fake = pollerFor(snapshot([], "1"));
  let resolve: ((client: typeof fake.client) => void) | undefined;
  fake.connect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fake.poller.start();
  fake.poller.stop();
  resolve?.(fake.client);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fake.client.status).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
