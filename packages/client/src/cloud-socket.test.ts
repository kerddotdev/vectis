import { afterEach, expect, test, vi } from "vitest";
import { createCloudSocket } from "./cloud-socket.js";

function fixture() {
  vi.useFakeTimers();
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    readyState: WebSocket["readyState"] = 0;
    onopen: WebSocket["onopen"] = null;
    onclose: WebSocket["onclose"] = null;
    onmessage: WebSocket["onmessage"] = null;
    onerror: WebSocket["onerror"] = null;
    send = vi.fn();
    close = vi.fn();
    constructor(
      public url: string,
      public protocols: string[],
    ) {
      super();
    }
  }
  const instances: FakeWebSocket[] = [];
  class Tracked extends FakeWebSocket {
    constructor(url: string, protocols: string[]) {
      super(url, protocols);
      instances.push(this);
    }
  }
  const status = {
    paused: false,
    runnerIdle: true,
    environments: [
      {
        id: "linux",
        name: "Linux",
        os: "linux" as const,
        cpu: 2,
        memoryMiB: 1024,
        state: "ready" as const,
      },
    ],
  };
  const onLoss = vi.fn();
  const onRemoved = vi.fn();
  const onChanged = vi.fn();
  const socket = createCloudSocket({
    url: "https://cloud.example",
    bearer: async () => "machine.secret",
    status: async () => status,
    onOpen: vi.fn(),
    onLoss,
    onRemoved,
    onChanged,
    WebSocket: Tracked,
  });
  // Dispatch through the handler's declared receiver without requiring a real socket.
  const open = (instance: FakeWebSocket) => {
    instance.readyState = 1;
    Reflect.apply(instance.onopen ?? (() => {}), instance, [new Event("open")]);
  };
  const message = (instance: FakeWebSocket, data: string) =>
    Reflect.apply(instance.onmessage ?? (() => {}), instance, [
      new MessageEvent("message", { data }),
    ]);
  const close = (instance: FakeWebSocket, code: number) =>
    Reflect.apply(instance.onclose ?? (() => {}), instance, [{ code }]);
  return { socket, instances, status, open, message, close, onLoss, onRemoved, onChanged };
}
afterEach(() => {
  vi.useRealTimers();
});
test("status changes and matching acknowledgements control waiters", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const first = f.instances[0]!;
  f.open(first);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.url).toBe("wss://cloud.example/machine/socket");
  expect(first.protocols).toEqual([
    "vectis.v1",
    `auth.${Buffer.from("machine.secret").toString("base64url")}`,
  ]);
  await f.socket.refreshStatus();
  expect(first.send).toHaveBeenCalledTimes(1);
  const resolved = vi.fn();
  const waiter = f.socket.waitForEnvironment("linux", new AbortController().signal).then(resolved);
  await vi.advanceTimersByTimeAsync(0);
  f.message(first, JSON.stringify({ t: "status.ack", seq: 99 }));
  expect(resolved).not.toHaveBeenCalled();
  f.message(first, JSON.stringify({ t: "status.ack", seq: 1 }));
  await waiter;
  f.status.paused = true;
  await f.socket.refreshStatus();
  expect(JSON.parse(first.send.mock.calls[1]![0])).toMatchObject({ seq: 2, paused: true });
  f.message(first, '{"t":"changed"}');
  expect(f.onChanged).toHaveBeenCalledOnce();
  f.socket.close();
  expect(first.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("missing pong closes and reconnects, then removal stops all timers", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const first = f.instances[0]!;
  f.open(first);
  await vi.advanceTimersByTimeAsync(75000);
  expect(first.close).toHaveBeenCalledWith(4000, "Pong timeout");
  f.close(first, 4000);
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.instances).toHaveLength(2);
  const second = f.instances[1]!;
  f.open(second);
  await vi.advanceTimersByTimeAsync(0);
  f.close(second, 4001);
  expect(f.onRemoved).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("pong keeps the socket alive and rejection reaches status waiters", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const first = f.instances[0]!;
  f.open(first);
  await vi.advanceTimersByTimeAsync(30000);
  f.message(first, "pong");
  await vi.advanceTimersByTimeAsync(30000);
  f.message(first, "pong");
  expect(first.close).not.toHaveBeenCalled();
  const waiting = f.socket.waitForEnvironment("missing", new AbortController().signal);
  const assertion = expect(waiting).rejects.toMatchObject({ code: "status_invalid" });
  await vi.advanceTimersByTimeAsync(0);
  f.message(first, '{"t":"status.rejected","seq":1,"code":"status_invalid"}');
  await assertion;
  f.socket.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("replacement reconnects with a fresh status and close cancels pending backoff", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const first = f.instances[0]!;
  f.open(first);
  await vi.advanceTimersByTimeAsync(0);
  f.close(first, 4002);
  await vi.advanceTimersByTimeAsync(1100);
  const second = f.instances[1]!;
  f.open(second);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(second.send.mock.calls[0]![0])).toMatchObject({ seq: 2, t: "status" });
  f.close(second, 4002);
  f.socket.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("closing while credentials load prevents a late socket creation", async () => {
  vi.useFakeTimers();
  let release: (bearer: string) => void = () => {};
  const socket = createCloudSocket({
    url: "https://cloud.example",
    bearer: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    status: async () => ({ paused: false, runnerIdle: true, environments: [] }),
    onOpen: vi.fn(),
    onChanged: vi.fn(),
    onLoss: vi.fn(),
    onRemoved: vi.fn(),
  });
  socket.close();
  release("machine.secret");
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.open).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
