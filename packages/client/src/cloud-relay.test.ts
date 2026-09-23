import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../../../apps/server/src/store.js";
import { VectisClient } from "./index.js";
import { startCloudRelay } from "./cloud-relay.js";

type Subscription = {
  name: string;
  args: Record<string, unknown>;
  deliver: (value: unknown) => void;
  fail: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};
const transport = vi.hoisted(() => {
  const subscriptions: Subscription[] = [];
  const auth: { changed?: (authenticated: boolean) => void } = {};
  return {
    subscriptions,
    auth,
    onUpdate: vi.fn(
      (
        query: FunctionReference<"query">,
        args: Record<string, unknown>,
        deliver: (value: unknown) => void,
        fail: () => void,
      ) => {
        const unsubscribe = vi.fn();
        subscriptions.push({ name: getFunctionName(query), args, deliver, fail, unsubscribe });
        return unsubscribe;
      },
    ),
    query:
      vi.fn<
        (query: FunctionReference<"query">, args: Record<string, unknown>) => Promise<unknown>
      >(),
    mutation: vi.fn(
      async (_mutation: FunctionReference<"mutation">, _args: Record<string, unknown>) => null,
    ),
    connectionState: vi.fn(() => ({ isWebSocketConnected: true })),
    disconnect: vi.fn(),
    close: vi.fn(async () => {}),
  };
});
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    onUpdate = transport.onUpdate;
    query = transport.query;
    mutation = transport.mutation;
    close = transport.close;
    client = {
      connectionState: transport.connectionState,
      subscribeToConnectionState: () => transport.disconnect,
    };
    setAuth(_fetchToken: unknown, changed: (authenticated: boolean) => void) {
      transport.auth.changed = changed;
    }
  },
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  transport.subscriptions.length = 0;
  delete transport.auth.changed;
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-relay-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "state.sqlite"));
  cleanup.push(async () => store.close());
  transport.connectionState.mockReturnValue({ isWebSocketConnected: true });
  transport.query.mockImplementation(async (query) => {
    if (getFunctionName(query) === "machines:self") return new Promise(() => {});
    return [];
  });
  const onJobObservations = vi.fn();
  const local = new VectisClient({ url: "http://127.0.0.1:1", token: "unused" });
  const relay = startCloudRelay(
    {
      deploymentUrl: "https://isolated-test.convex.cloud",
      machineId: "machine1",
      localId: store.snapshot().machine.id,
    },
    local,
    { get: async () => null },
    vi.fn(),
    () => store.touch(),
    onJobObservations,
  );
  cleanup.push(() => relay.close());
  const subscription = (name: string, bindingId?: string) => {
    const found = transport.subscriptions.findLast(
      (item) => item.name === name && item.args.bindingId === bindingId,
    );
    if (!found) throw new Error(`Missing subscription: ${name} ${bindingId ?? ""}`);
    return found;
  };
  return {
    relay,
    local,
    onJobObservations,
    store,
    subscription,
    repositories: subscription("repositoryBindings:forMachine"),
  };
}

const binding = (id: string) => ({
  id,
  repositoryId: 1,
  repositoryName: "owner/repo",
  environmentId: "linux",
  automatic: false,
});
const job = {
  jobId: 1,
  runId: 2,
  name: "Build",
  status: "queued",
  conclusion: null,
  labels: ["vectis-linux"],
  runnerId: null,
  runnerName: null,
  updatedAt: 1,
};

test("repository and job changes invalidate snapshots without repeating identical updates", async () => {
  const { relay, store, repositories, subscription } = await fixture();
  const initial = store.snapshot().revision;
  repositories.deliver([binding("binding1")]);
  expect(relay.repositorySnapshot).toEqual([binding("binding1")]);
  const connected = store.snapshot().revision;
  expect(connected).not.toBe(initial);
  repositories.deliver([Object.fromEntries(Object.entries(binding("binding1")).reverse())]);
  expect(store.snapshot().revision).toBe(connected);
  const jobs = subscription("jobs:list", "binding1");
  jobs.deliver([job]);
  const queued = store.snapshot().revision;
  expect(queued).not.toBe(connected);
  jobs.deliver([{ ...job }]);
  expect(store.snapshot().revision).toBe(queued);
  jobs.deliver([{ ...job, status: "completed", conclusion: "success", updatedAt: 2 }]);
  expect(store.snapshot().revision).not.toBe(queued);
  expect(store.snapshot()).not.toHaveProperty("jobs");
  const beforeInvalid = store.snapshot().revision;
  repositories.deliver([{ ...binding("binding1"), environmentId: "invalid/id" }]);
  expect(relay.repositorySnapshot).toEqual([binding("binding1")]);
  expect(store.snapshot().revision).toBe(beforeInvalid);
  repositories.deliver([]);
  expect(relay.repositorySnapshot).toEqual([]);
  expect(store.snapshot().revision).not.toBe(beforeInvalid);
  expect(jobs.unsubscribe).toHaveBeenCalledOnce();
});

test("job subscriptions keep the newest 20 bindings and release removed bindings and shutdown resources", async () => {
  const { relay, store, repositories, subscription } = await fixture();
  const bindings = Array.from({ length: 22 }, (_, index) => binding(`binding${index}`));
  repositories.deliver(bindings);
  expect(
    transport.subscriptions
      .filter((item) => item.name === "jobs:list")
      .map((item) => item.args.bindingId),
  ).toEqual(bindings.slice(2).map((item) => item.id));
  const removed = subscription("jobs:list", "binding21");
  repositories.deliver(bindings.slice(0, -1));
  expect(removed.unsubscribe).toHaveBeenCalledOnce();
  expect(subscription("jobs:list", "binding1").unsubscribe).not.toHaveBeenCalled();
  const revision = store.snapshot().revision;
  removed.deliver([job]);
  expect(store.snapshot().revision).toBe(revision);
  await relay.close();
  cleanup.pop();
  for (const item of transport.subscriptions) expect(item.unsubscribe).toHaveBeenCalledOnce();
  expect(transport.disconnect).toHaveBeenCalledOnce();
  expect(transport.close).toHaveBeenCalledOnce();
  repositories.deliver([binding("late")]);
  subscription("jobs:list", "binding1").deliver([job]);
  expect(store.snapshot().revision).toBe(revision);
});

test("jobs use live subscription values and query when uncached, disconnected or invalidated", async () => {
  const { relay, repositories, subscription } = await fixture();
  transport.auth.changed?.(true);
  repositories.deliver([binding("binding1")]);
  const jobs = subscription("jobs:list", "binding1");
  const queries = () =>
    transport.query.mock.calls.filter(([query]) => getFunctionName(query) === "jobs:list");
  expect(await relay.jobs("binding1")).toEqual([]);
  expect(queries()).toHaveLength(1);
  jobs.deliver([job]);
  expect(await relay.jobs("binding1")).toEqual([job]);
  expect(await relay.jobs("binding1")).toEqual([job]);
  expect(queries()).toHaveLength(1);
  jobs.deliver([]);
  expect(await relay.jobs("binding1")).toEqual([]);
  expect(queries()).toHaveLength(1);
  transport.connectionState.mockReturnValue({ isWebSocketConnected: false });
  await relay.jobs("binding1");
  expect(queries()).toHaveLength(2);
  transport.connectionState.mockReturnValue({ isWebSocketConnected: true });
  jobs.fail();
  await relay.jobs("binding1");
  expect(queries()).toHaveLength(3);
  jobs.deliver([job]);
  repositories.deliver([]);
  await relay.jobs("binding1");
  expect(queries()).toHaveLength(4);
});

test("cached jobs still require authentication and query failures retain their error contract", async () => {
  const { relay, repositories, subscription } = await fixture();
  repositories.deliver([binding("binding1")]);
  subscription("jobs:list", "binding1").deliver([job]);
  await expect(relay.jobs("binding1")).rejects.toMatchObject({ code: "cloud_unavailable" });
  transport.auth.changed?.(true);
  transport.query.mockRejectedValueOnce(new Error("Access denied"));
  await expect(relay.jobs("unsubscribed")).rejects.toMatchObject({
    code: "job_access_unavailable",
  });
  transport.auth.changed?.(false);
  await expect(relay.jobs("binding1")).rejects.toMatchObject({ code: "cloud_unavailable" });
});

test("lease observations use one subscription per set and release stale callbacks", async () => {
  const { relay, subscription, onJobObservations } = await fixture();
  relay.watchLeases(["lease2", "lease1", "lease1"]);
  const first = subscription("jobs:forLeases");
  expect(first.args).toEqual({ leaseIds: ["lease1", "lease2"] });
  relay.watchLeases(["lease1", "lease2"]);
  expect(transport.subscriptions.filter((item) => item.name === "jobs:forLeases")).toHaveLength(1);
  const observations = [{ leaseId: "lease1", job }];
  first.deliver(observations);
  expect(onJobObservations).toHaveBeenCalledWith(observations);
  relay.watchLeases(["lease2"]);
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  first.deliver(observations);
  expect(onJobObservations).toHaveBeenCalledOnce();
  const second = subscription("jobs:forLeases");
  second.deliver([{ leaseId: "lease2", job: { ...job, status: "unknown" } }]);
  expect(onJobObservations).toHaveBeenCalledOnce();
  relay.watchLeases([]);
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  relay.watchLeases(["lease3"]);
  const last = subscription("jobs:forLeases");
  await relay.close();
  cleanup.pop();
  expect(last.unsubscribe).toHaveBeenCalledOnce();
  last.deliver(observations);
  relay.watchLeases(["lease4"]);
  expect(onJobObservations).toHaveBeenCalledOnce();
  expect(transport.subscriptions.filter((item) => item.name === "jobs:forLeases")).toHaveLength(3);
});

test("slot changes send a heartbeat on the next tick without waiting for the cadence", async () => {
  vi.useFakeTimers();
  const { store, local } = await fixture();
  let available = 2;
  vi.spyOn(local, "status").mockImplementation(async () => ({
    ...store.snapshot(),
    runnerCapacity: { max: 5, active: 1, available },
  }));
  transport.query.mockImplementation(async (query) =>
    getFunctionName(query) === "machines:self"
      ? { id: "machine1", localId: store.snapshot().machine.id }
      : [],
  );
  transport.auth.changed?.(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.mutation).toHaveBeenCalledTimes(1);
  expect(transport.mutation.mock.calls[0]?.[1]).toMatchObject({ runnerSlots: 2, runnerIdle: true });
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.mutation).toHaveBeenCalledTimes(1);
  available = 0;
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.mutation).toHaveBeenCalledTimes(2);
  expect(transport.mutation.mock.calls[1]?.[1]).toMatchObject({ runnerSlots: 0, runnerIdle: true });
  vi.mocked(local.status).mockImplementation(async () => store.snapshot());
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.mutation).toHaveBeenCalledTimes(3);
  expect(transport.mutation.mock.calls[2]?.[1]).not.toHaveProperty("runnerSlots");
  await vi.advanceTimersByTimeAsync(2000);
  expect(transport.mutation).toHaveBeenCalledTimes(3);
});
