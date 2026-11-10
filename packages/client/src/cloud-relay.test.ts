import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../../../apps/server/src/store.js";
import { VectisClient } from "./index.js";
import { startCloudRelay } from "./cloud-relay.js";
import type { SyncSnapshot } from "../../protocol/src/cloud.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  vi.useFakeTimers();
  const home = await mkdtemp(join(tmpdir(), "vectis-relay-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "state.sqlite"));
  cleanup.push(async () => store.close());
  const local = new VectisClient({ url: "http://127.0.0.1:1", token: "unused" });
  vi.spyOn(local, "status").mockImplementation(async () => store.snapshot());
  const submit = vi
    .spyOn(local, "submit")
    .mockImplementation(
      async (command, key) => store.accept(key, JSON.stringify(command), command.type).operation,
    );
  const snapshot: { -readonly [P in keyof SyncSnapshot]: SyncSnapshot[P] } = {
    operations: [],
    inspections: [],
    repositories: [],
    jobMarkers: {},
    observations: [],
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/machine/sync")) return Response.json(snapshot);
    if (String(url).endsWith("/machine/jobs/list")) return Response.json([]);
    if (String(url).endsWith("/machine/repositories/connect"))
      return Response.json({ bindingId: "binding1" });
    return Response.json(null);
  });
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState: WebSocket["readyState"] = 0;
    onopen: WebSocket["onopen"] = null;
    onclose: WebSocket["onclose"] = null;
    onmessage: WebSocket["onmessage"] = null;
    onerror: WebSocket["onerror"] = null;
    send = vi.fn();
    close = vi.fn();
    constructor(_url: string, _protocols: string[]) {
      super();
      instances.push(this);
    }
  }
  const instances: FakeWebSocket[] = [];
  const onState = vi.fn();
  const onChange = vi.fn();
  const observations = vi.fn();
  const relay = startCloudRelay(
    {
      deploymentUrl: "https://cloud.example",
      machineId: "machine1",
      localId: store.snapshot().machine.id,
    },
    local,
    { get: async () => "s".repeat(43) },
    onState,
    onChange,
    observations,
    { fetch: fetcher, WebSocket: FakeWebSocket },
  );
  cleanup.push(() => relay.close());
  await vi.advanceTimersByTimeAsync(0);
  const ws = instances[0]!;
  const message = (data: unknown) =>
    Reflect.apply(ws.onmessage ?? (() => {}), ws, [
      new MessageEvent("message", { data: JSON.stringify(data) }),
    ]);
  const open = async () => {
    ws.readyState = 1;
    Reflect.apply(ws.onopen ?? (() => {}), ws, [new Event("open")]);
    await flush();
  };
  const requests = (path: string) =>
    fetcher.mock.calls.filter(([url]) => String(url).endsWith(path));
  return {
    home,
    store,
    local,
    submit,
    snapshot,
    fetcher,
    instances,
    ws,
    relay,
    onState,
    onChange,
    observations,
    message,
    open,
    requests,
  };
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
test("connect sends status, syncs operations and answers at most two inspections", async () => {
  const f = await fixture();
  f.snapshot.operations = [
    {
      id: "operation1",
      phase: "accepted",
      commandJson: '{"type":"machine.pause","paused":true}',
      cancelRequested: false,
      createdAt: 1,
    },
  ];
  f.snapshot.inspections = ["one", "two", "three"].map((id) => ({
    id,
    queryJson: '{"name":"status"}',
  }));
  await f.open();
  expect(f.ws.send).toHaveBeenCalledWith(expect.stringContaining('"t":"status"'));
  expect(f.requests("/machine/operations/acknowledge")).toHaveLength(1);
  expect(JSON.parse(String(f.requests("/machine/operations/acknowledge")[0]![1]?.body))).toEqual({
    id: "operation1",
    phase: "claimed",
  });
  expect(f.requests("/machine/inspections/respond")).toHaveLength(2);
  expect(f.onState.mock.calls.map(([state]) => state)).toEqual(["connecting", "connected"]);
});
test("changed notifications coalesce and lease watches are included in sync", async () => {
  const f = await fixture();
  await f.open();
  let resolve: (response: Response) => void = () => {};
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  f.message({ t: "changed" });
  await flush();
  f.message({ t: "changed" });
  f.message({ t: "changed" });
  f.relay.watchLeases(["lease2", "lease1", "lease1"]);
  resolve(Response.json(f.snapshot));
  await flush();
  expect(f.requests("/machine/sync")).toHaveLength(3);
  expect(JSON.parse(String(f.requests("/machine/sync")[2]![1]?.body))).toEqual({
    leaseIds: ["lease1", "lease2"],
  });
  expect(f.observations).toHaveBeenCalled();
});
test.each(["http", "socket"])("removal through %s stops the relay", async (mode) => {
  const f = await fixture();
  if (mode === "http")
    f.fetcher.mockResolvedValueOnce(
      Response.json({ code: "machine_unauthorized" }, { status: 401 }),
    );
  await f.open();
  if (mode === "socket") Reflect.apply(f.ws.onclose ?? (() => {}), f.ws, [{ code: 4001 }]);
  await flush();
  expect(f.onState).toHaveBeenLastCalledWith("removed");
  expect(vi.getTimerCount()).toBe(0);
});
test("local status is sent only when fields change and close releases timers", async () => {
  const f = await fixture();
  await f.open();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.ws.send).toHaveBeenCalledTimes(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.store.put("machine", "self", { ...f.store.snapshot().machine, paused: true });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.ws.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(f.ws.send.mock.calls[1]![0])).toMatchObject({ paused: true, seq: 2 });
  await f.relay.close();
  expect(f.ws.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("connectRepository waits for the status acknowledgement containing its environment", async () => {
  const f = await fixture();
  const basePath = join(f.home, "base.img");
  await writeFile(basePath, "synthetic");
  f.store.put("environment", "linux", {
    id: "linux",
    name: "Linux",
    os: "linux",
    basePath,
    cpu: 2,
    memoryMiB: 2048,
    diskGiB: 10,
    state: "ready",
    createdAt: Date.now(),
  });
  await f.open();
  const result = f.relay.connectRepository(
    { accountId: "account1", environmentId: "linux", repositoryName: "repo" },
    new AbortController().signal,
  );
  await flush();
  expect(f.requests("/machine/repositories/connect")).toHaveLength(0);
  f.message({ t: "status.ack", seq: 99 });
  await flush();
  expect(f.requests("/machine/repositories/connect")).toHaveLength(0);
  f.message({ t: "status.ack", seq: 1 });
  expect(await result).toBe("binding1");
  f.fetcher.mockRejectedValueOnce(new Error("response lost"));
  await expect(
    f.relay.connectRepository(
      { accountId: "account1", environmentId: "linux", repositoryName: "repo" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "repository_connection_unconfirmed" });
});
test("automatic bindings submit staggered hourly scans with stable keys", async () => {
  const f = await fixture();
  f.snapshot.repositories = ["one", "two"].map((id, index) => ({
    id,
    repositoryId: index + 1,
    repositoryName: id,
    environmentId: "linux",
    automatic: true,
  }));
  await f.open();
  await flush();
  expect(f.submit).toHaveBeenCalledWith(
    { type: "job.scan", bindingId: "one", automatic: true },
    expect.stringMatching(/^cloud-scan:one:\d+$/),
    expect.any(AbortSignal),
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.submit).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 120; i++) {
    await vi.advanceTimersByTimeAsync(30000);
    Reflect.apply(f.ws.onmessage ?? (() => {}), f.ws, [
      new MessageEvent("message", { data: "pong" }),
    ]);
  }
  expect(
    f.submit.mock.calls.filter(([command]) => command.type === "job.scan").length,
  ).toBeGreaterThanOrEqual(3);
});
test("job list cache follows markers and repository access changes", async () => {
  const f = await fixture();
  f.snapshot.repositories = [
    { id: "binding1", repositoryId: 1, repositoryName: "repo", environmentId: "linux" },
  ];
  f.snapshot.jobMarkers = { binding1: null };
  await f.open();
  await f.relay.jobs("binding1");
  await f.relay.jobs("binding1");
  expect(f.requests("/machine/jobs/list")).toHaveLength(1);
  f.snapshot.jobMarkers = { binding1: 1 };
  f.message({ t: "changed" });
  await flush();
  await f.relay.jobs("binding1");
  expect(f.requests("/machine/jobs/list")).toHaveLength(2);
  f.snapshot.repositories = [
    { ...f.snapshot.repositories[0]!, access: { actors: "any", approval: "required" } },
  ];
  f.message({ t: "changed" });
  await flush();
  await f.relay.jobs("binding1");
  expect(f.requests("/machine/jobs/list")).toHaveLength(3);
});

test("claimed operations finish through local polling without cloud sync traffic", async () => {
  const f = await fixture();
  f.snapshot.operations = [
    {
      id: "remote1",
      phase: "claimed",
      commandJson: '{"type":"machine.pause","paused":true}',
      cancelRequested: false,
      createdAt: 1,
    },
  ];
  await f.open();
  const host = f.store.operationByKey("remote:remote1");
  f.store.update(host, { status: "running" });
  await vi.advanceTimersByTimeAsync(5000);
  f.store.update(host, { status: "succeeded", message: "Paused." });
  await vi.advanceTimersByTimeAsync(5000);
  const phases = f
    .requests("/machine/operations/acknowledge")
    .map(([, init]) => JSON.parse(String(init?.body)).phase);
  expect(phases).toEqual(["running", "succeeded"]);
  expect(f.requests("/machine/sync")).toHaveLength(1);
});

test("sync failures report unavailable and retry without waiting for a new event", async () => {
  const f = await fixture();
  f.fetcher.mockRejectedValueOnce(new Error("offline"));
  await f.open();
  expect(f.onState).toHaveBeenLastCalledWith("unavailable");
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.onState).toHaveBeenLastCalledWith("connected");
});

test("repository and job access failures preserve the public error wrappers", async () => {
  const f = await fixture();
  await f.open();
  f.fetcher.mockRejectedValueOnce(new Error("offline"));
  await expect(f.relay.jobs("binding1")).rejects.toMatchObject({ code: "job_access_unavailable" });
  f.fetcher.mockRejectedValueOnce(new Error("offline"));
  await expect(f.relay.repositories()).rejects.toMatchObject({
    code: "repository_access_unavailable",
  });
});

test("a job read cannot populate the cache under a newer marker", async () => {
  const f = await fixture();
  f.snapshot.repositories = [
    { id: "binding1", repositoryId: 1, repositoryName: "repo", environmentId: "linux" },
  ];
  f.snapshot.jobMarkers = { binding1: 1 };
  await f.open();
  let resolve: (response: Response) => void = () => {};
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const jobs = f.relay.jobs("binding1");
  await flush();
  f.snapshot.jobMarkers = { binding1: 2 };
  f.message({ t: "changed" });
  await flush();
  resolve(Response.json([]));
  await jobs;
  await f.relay.jobs("binding1");
  expect(f.requests("/machine/jobs/list")).toHaveLength(2);
});

test("operation cancellation refusals do not keep retrying claims", async () => {
  const f = await fixture();
  f.snapshot.operations = [
    {
      id: "remote1",
      phase: "accepted",
      commandJson: '{"type":"machine.pause","paused":true}',
      cancelRequested: false,
      createdAt: 1,
    },
  ];
  f.fetcher.mockImplementation(async (url) =>
    String(url).endsWith("/machine/sync")
      ? Response.json(f.snapshot)
      : Response.json({ code: "operation_cancelled" }, { status: 409 }),
  );
  await f.open();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.requests("/machine/operations/acknowledge")).toHaveLength(1);
  expect(f.submit).not.toHaveBeenCalled();
});
