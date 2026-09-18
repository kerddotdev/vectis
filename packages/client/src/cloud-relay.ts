import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import { VectisError } from "../../protocol/src/index.js";
import { advanceRemoteOperation } from "./remote-operation.js";
import { machineTokenFetcher, type CloudConnection } from "./machine-auth.js";
import type { KeychainCredentials } from "./keychain.js";
import type { VectisClient } from "./index.js";

function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function startCloudRelay(
  connection: CloudConnection,
  local: VectisClient,
  credentials: Pick<KeychainCredentials, "get">,
  onState: (state: "connecting" | "connected" | "unavailable") => void,
) {
  const abort = new AbortController();
  const fetchToken = machineTokenFetcher(connection, credentials, abort.signal);
  const cloud = new ConvexClient(connection.deploymentUrl, { logger: false });
  let authenticated = false;
  let refreshing = false;
  let active: Promise<void> | undefined;
  let tokenRequest: Promise<string | null> | undefined;
  let lastHeartbeat = 0;
  let rerun = false;
  onState("connecting");
  const authenticate = () => {
    if (refreshing || abort.signal.aborted) return;
    refreshing = true;
    cloud.setAuth(
      async (options) => {
        try {
          tokenRequest = fetchToken(options);
          return await tokenRequest;
        } catch {
          onState("unavailable");
          return null;
        } finally {
          refreshing = false;
          tokenRequest = undefined;
        }
      },
      (value) => {
        authenticated = value;
        if (!value) onState("unavailable");
        else tick();
      },
    );
  };
  async function reconcile() {
    const identity = await interruptible(cloud.query(api.machines.self, {}), abort.signal);
    const snapshot = await local.status(abort.signal);
    if (
      identity.id !== connection.machineId ||
      identity.localId !== connection.localId ||
      identity.localId !== snapshot.machine.id
    )
      throw new VectisError(
        "machine_identity_mismatch",
        "This credential belongs to another local machine.",
      );
    if (Date.now() - lastHeartbeat >= 30000) {
      await interruptible(cloud.mutation(api.machines.heartbeat, {}), abort.signal);
      lastHeartbeat = Date.now();
    }
    const operations = await interruptible(cloud.query(api.operations.pending, {}), abort.signal);
    for (const operation of operations)
      await advanceRemoteOperation(
        operation,
        local,
        (args) => {
          abort.signal.throwIfAborted();
          return interruptible(cloud.mutation(api.operations.acknowledge, args), abort.signal);
        },
        abort.signal,
      );
    onState(cloud.client.connectionState().isWebSocketConnected ? "connected" : "unavailable");
  }
  function tick() {
    if (abort.signal.aborted) return;
    if (!authenticated) {
      authenticate();
      return;
    }
    if (active) {
      rerun = true;
      return;
    }
    active = reconcile()
      .catch(() => {
        if (!abort.signal.aborted) onState("unavailable");
      })
      .finally(() => {
        active = undefined;
        if (rerun) {
          rerun = false;
          tick();
        }
      });
  }
  const unsubscribe = cloud.onUpdate(api.operations.pending, {}, tick, () =>
    onState("unavailable"),
  );
  const disconnect = cloud.client.subscribeToConnectionState((state) => {
    if (!state.isWebSocketConnected) onState("unavailable");
  });
  const interval = setInterval(tick, 2000);
  authenticate();
  return {
    async close() {
      const pendingToken = tokenRequest;
      abort.abort();
      clearInterval(interval);
      unsubscribe();
      disconnect();
      await cloud.close();
      await pendingToken?.catch(() => {});
      await active;
    },
  };
}
