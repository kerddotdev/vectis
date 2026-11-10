import { Schema } from "effect";
import { MachineStatus, ServerSocketMessage } from "../../protocol/src/cloud.js";
import { VectisError } from "../../protocol/src/index.js";

export type StatusFields = Omit<MachineStatus, "t" | "seq">;
export type Socket = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "onopen" | "onclose" | "onerror" | "onmessage"
>;
export type SocketConstructor = { new (url: string, protocols: string[]): Socket; OPEN: number };
export type CloudSocketOptions = {
  url: string;
  bearer: () => Promise<string>;
  status: () => Promise<StatusFields>;
  onOpen: () => void;
  onChanged: () => void;
  onLoss: (error?: unknown) => void;
  onRemoved: () => void;
  WebSocket?: SocketConstructor;
};

export function createCloudSocket(options: CloudSocketOptions) {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  let socket: Socket | undefined;
  let closed = false;
  let seq = 0;
  let attempt = 0;
  let statusKey: string | undefined;
  let acknowledged: MachineStatus | undefined;
  const pending = new Map<number, MachineStatus>();
  const waiters = new Set<{
    environmentId: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let pong: ReturnType<typeof setTimeout> | undefined;
  let refresh: Promise<void> | undefined;
  function clearHeartbeat() {
    clearInterval(ping);
    clearTimeout(pong);
    ping = undefined;
    pong = undefined;
  }
  function rejectWaiters(error: unknown) {
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  }
  function reconnect() {
    if (closed || retry) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6)) * (0.5 + Math.random() * 0.5);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
  }
  async function refreshStatus() {
    if (refresh) return refresh;
    refresh = (async () => {
      const fields = await options.status();
      const key = JSON.stringify(fields);
      if (closed || socket?.readyState !== Socket.OPEN || key === statusKey) return;
      const message: MachineStatus = { t: "status", seq: ++seq, ...fields };
      if (pending.size >= 100) {
        socket.close(4000, "Status acknowledgement timeout");
        throw new VectisError("cloud_unavailable", "The cloud did not acknowledge machine status.");
      }
      pending.set(message.seq, message);
      socket.send(JSON.stringify(message));
      statusKey = key;
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }
  async function connect() {
    try {
      const bearer = await options.bearer();
      if (closed) return;
      const url = new URL("/machine/socket", options.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const current = new Socket(url.toString(), [
        "vectis.v1",
        `auth.${Buffer.from(bearer).toString("base64url")}`,
      ]);
      socket = current;
      current.onopen = () => {
        if (closed || socket !== current) return;
        statusKey = undefined;
        acknowledged = undefined;
        pending.clear();
        ping = setInterval(() => {
          current.send("ping");
          pong ??= setTimeout(() => current.close(4000, "Pong timeout"), 45000);
        }, 30000);
        void refreshStatus().catch(options.onLoss);
        options.onOpen();
      };
      current.onmessage = (event) => {
        if (closed || socket !== current) return;
        if (event.data === "pong") {
          clearTimeout(pong);
          pong = undefined;
          attempt = 0;
          return;
        }
        try {
          const message = Schema.decodeUnknownSync(ServerSocketMessage)(
            JSON.parse(String(event.data)),
          );
          if (message.t === "changed") options.onChanged();
          else if (message.t === "status.rejected") {
            pending.delete(message.seq);
            statusKey = undefined;
            const error = new VectisError(message.code, "The cloud rejected the machine status.");
            rejectWaiters(error);
            options.onLoss(error);
          } else {
            const status = pending.get(message.seq);
            if (!status) return;
            if (!acknowledged || status.seq > acknowledged.seq) acknowledged = status;
            for (const key of pending.keys()) if (key <= message.seq) pending.delete(key);
            for (const waiter of waiters)
              if (status.environments.some(({ id }) => id === waiter.environmentId)) {
                waiter.resolve();
                waiters.delete(waiter);
              }
          }
        } catch (error) {
          options.onLoss(error);
        }
      };
      current.onerror = () => options.onLoss();
      current.onclose = (event) => {
        if (socket !== current) return;
        clearHeartbeat();
        socket = undefined;
        acknowledged = undefined;
        pending.clear();
        if (closed) return;
        if (event.code === 4001) {
          close();
          options.onRemoved();
        } else {
          options.onLoss();
          reconnect();
        }
      };
    } catch (error) {
      if (!closed) {
        options.onLoss(error);
        reconnect();
      }
    }
  }
  function close() {
    closed = true;
    clearHeartbeat();
    clearTimeout(retry);
    retry = undefined;
    rejectWaiters(new VectisError("cloud_unavailable", "The cloud socket is closed."));
    const current = socket;
    socket = undefined;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      current.close();
    }
    pending.clear();
  }
  void connect();
  return {
    get open() {
      return socket?.readyState === Socket.OPEN;
    },
    refreshStatus,
    async waitForEnvironment(environmentId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      await refreshStatus();
      signal.throwIfAborted();
      if (closed) throw new VectisError("cloud_unavailable", "The cloud socket is closed.");
      if (acknowledged?.environments.some(({ id }) => id === environmentId)) return;
      await new Promise<void>((resolve, reject) => {
        const waiter = { environmentId, resolve, reject };
        const cancel = () => {
          waiters.delete(waiter);
          reject(signal.reason);
        };
        waiter.resolve = () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        };
        waiter.reject = (error) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        };
        waiters.add(waiter);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    },
    close,
  };
}
