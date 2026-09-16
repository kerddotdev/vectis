import { environmentRevision } from "./environment-revision.js";
import { MigrationAnalysis, MigrationPublication } from "../../protocol/src/migrations.js";
import type { RepositoryConnection } from "../../protocol/src/repositories.js";
import { JobRefresh, JobScan } from "../../protocol/src/jobs.js";
import { Schema } from "effect";
import { RunnerGrant, RunnerLease } from "../../protocol/src/runners.js";
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
      await interruptible(
        cloud.mutation(api.machines.heartbeat, {
          paused: snapshot.machine.paused,
          runnerIdle:
            snapshot.instances.every((instance) => instance.status === "stopped") &&
            !snapshot.operations.some(
              (operation) =>
                operation.command === "runner.run" &&
                ["accepted", "running", "action_required"].includes(operation.status),
            ),
          environments: await Promise.all(
            snapshot.environments.slice(0, 100).map(async (environment) => {
              const { id, name, os, cpu, memoryMiB, state } = environment;
              const revision = await environmentRevision(environment);
              return {
                id,
                name,
                os,
                cpu,
                memoryMiB,
                state: revision ? state : ("action_required" as const),
                ...(revision ? { revision } : {}),
              };
            }),
          ),
        }),
        abort.signal,
      );
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
  function requireConnection() {
    if (!authenticated || abort.signal.aborted)
      throw new VectisError(
        "cloud_unavailable",
        "The machine cloud connection is unavailable.",
        "Reconnect this machine before requesting runner control.",
      );
  }
  return {
    async analyzeMigration(bindingId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await interruptible(
        cloud.action(api.githubMigrations.analyze, { bindingId }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(MigrationAnalysis)(result);
    },
    async publishMigration(previewId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await interruptible(
        cloud.action(api.githubMigrations.publish, { previewId }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(MigrationPublication)(result);
    },
    async githubAccounts() {
      requireConnection();
      return interruptible(
        cloud.query(api.githubIdentity.forMachine, {}),
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async connectRepository(input: RepositoryConnection, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      return interruptible(
        cloud.action(api.githubRepositories.connectMachine, input),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60000)]),
      );
    },
    async setAutomatic(bindingId: string, enabled: boolean) {
      requireConnection();
      await interruptible(
        cloud.mutation(api.repositoryBindings.setAutomatic, { bindingId, enabled }),
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async scanJobs(bindingId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await interruptible(
        cloud.action(api.githubJobs.scan, { bindingId }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(JobScan)(result);
    },
    async refreshJob(bindingId: string, jobId: number, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await interruptible(
        cloud.action(api.githubJobs.refresh, { bindingId, jobId }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60000)]),
      );
      return Schema.decodeUnknownSync(JobRefresh)(result);
    },
    async jobs(bindingId: string) {
      requireConnection();
      try {
        return await interruptible(
          cloud.query(api.jobs.list, { bindingId }),
          AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        );
      } catch {
        throw new VectisError(
          "job_access_unavailable",
          "Repository job state could not be read.",
          "Check this machine's repository binding and cloud connection, then retry.",
        );
      }
    },
    async findRunner(key: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const value = await interruptible(
        cloud.query(api.runnerLeases.find, { key }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(10000)]),
      );
      return value === null ? null : Schema.decodeUnknownSync(RunnerLease)(value);
    },
    async prepareRunner(bindingId: string, key: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const value = await interruptible(
        cloud.action(api.githubRunners.prepare, { bindingId, key }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60000)]),
      );
      return Schema.decodeUnknownSync(RunnerGrant)(value);
    },
    async releaseRunner(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      await interruptible(
        cloud.action(api.githubRunners.release, { id }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60000)]),
      );
    },
    async repositories() {
      if (!authenticated || abort.signal.aborted)
        throw new VectisError(
          "cloud_unavailable",
          "The machine cloud connection is unavailable.",
          "Reconnect this machine and retry repository list.",
        );
      try {
        return await interruptible(
          cloud.query(api.repositoryBindings.forMachine, {}),
          AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        );
      } catch {
        throw new VectisError(
          "repository_access_unavailable",
          "Repository access could not be verified.",
          "Check the machine connection and linked GitHub account, then retry.",
        );
      }
    },
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
