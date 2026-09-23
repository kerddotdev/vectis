import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { isDeepStrictEqual } from "node:util";
import { environmentRevision } from "./environment-revision.js";
import { MigrationAnalysis, MigrationPublication } from "../../protocol/src/migrations.js";
import { MachineRepositories, type RepositoryConnection } from "../../protocol/src/repositories.js";
import { JobRefresh, JobScan, JobObservations } from "../../protocol/src/jobs.js";
import { Schema } from "effect";
import { RunnerGrant, RunnerLease } from "../../protocol/src/runners.js";
import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import { VectisError } from "../../protocol/src/index.js";
import { answerInspection } from "./inspection.js";
import { advanceRemoteOperation } from "./remote-operation.js";
import { machineTokenFetcher, type CloudConnection } from "./machine-auth.js";
import type { KeychainCredentials } from "./keychain.js";
import type { VectisClient } from "./index.js";

function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, (error: unknown) => {
        if (
          error instanceof ConvexError &&
          Schema.is(
            Schema.Struct({
              code: Schema.Literals([
                "public_runner_approval_required",
                "repository_admin_required",
                "github_app_not_installed",
                "machine_revoked",
              ]),
              message: Schema.String,
              nextStep: Schema.String,
            }),
          )(error.data)
        )
          reject(new VectisError(error.data.code, error.data.message, error.data.nextStep));
        else reject(error);
      })
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

const removalCodes = ["machine_rejected", "machine_revoked"];

export function startCloudRelay(
  connection: CloudConnection,
  local: VectisClient,
  credentials: Pick<KeychainCredentials, "get">,
  onState: (state: "connecting" | "connected" | "unavailable" | "removed") => void,
  onChange: () => void,
  onJobObservations: (entries: JobObservations) => void,
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
  let removed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  // Undefined until the first value arrives: an empty list means no repositories, which is not
  // the same as not having heard from the cloud yet.
  let repositorySnapshot: MachineRepositories | undefined;
  const jobSubscriptions = new Map<string, () => void>();
  const jobValues = new Map<string, FunctionReturnType<typeof api.jobs.list>>();
  let watchedLeaseIds: readonly string[] = [];
  let unsubscribeLeases: (() => void) | undefined;
  const report = (state: "connecting" | "connected" | "unavailable" | "removed") => {
    if (!removed) onState(state);
  };
  // A rejected credential means the account no longer has this machine. Retrying cannot fix that,
  // so the relay stops and the surfaces tell the user to disconnect and pair again.
  const machineRemoved = () => {
    if (removed) return;
    onState("removed");
    removed = true;
    if (interval) clearInterval(interval);
  };
  report("connecting");
  const authenticate = () => {
    if (refreshing || abort.signal.aborted) return;
    refreshing = true;
    cloud.setAuth(
      async (options) => {
        try {
          tokenRequest = fetchToken(options);
          return await tokenRequest;
        } catch (error) {
          if (error instanceof VectisError && removalCodes.includes(error.code)) machineRemoved();
          else report("unavailable");
          return null;
        } finally {
          refreshing = false;
          tokenRequest = undefined;
        }
      },
      (value) => {
        authenticated = value;
        if (!value) report("unavailable");
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
            snapshot.preparationBusy !== true &&
            snapshot.instances.every((instance) => instance.status === "stopped") &&
            !snapshot.operations.some((operation) =>
              operation.command === "runner.run"
                ? ["accepted", "running", "action_required"].includes(operation.status)
                : [
                    "environment.prepare-linux",
                    "environment.resume",
                    "environment.install-macos",
                    "environment.install-windows",
                    "environment.resume-windows",
                    "environment.resume-macos",
                    "environment.open-macos-setup",
                  ].includes(operation.command) &&
                  ["accepted", "running"].includes(operation.status),
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
    const inspections = await interruptible(cloud.query(api.inspections.pending, {}), abort.signal);
    for (const inspection of inspections.slice(0, 2)) {
      const responseJson = await answerInspection(inspection.queryJson, local, abort.signal);
      await interruptible(
        cloud.mutation(api.inspections.respond, { id: inspection.id, responseJson }),
        abort.signal,
      );
    }
    report(cloud.client.connectionState().isWebSocketConnected ? "connected" : "unavailable");
  }
  function tick() {
    if (abort.signal.aborted || removed) return;
    if (!authenticated) {
      authenticate();
      return;
    }
    if (active) {
      rerun = true;
      return;
    }
    active = reconcile()
      .catch((error: unknown) => {
        if (error instanceof VectisError && removalCodes.includes(error.code)) machineRemoved();
        else if (!abort.signal.aborted) report("unavailable");
      })
      .finally(() => {
        active = undefined;
        if (rerun) {
          rerun = false;
          tick();
        }
      });
  }
  const unsubscribe = cloud.onUpdate(api.operations.pending, {}, tick, () => report("unavailable"));
  const unsubscribeInspections = cloud.onUpdate(api.inspections.pending, {}, tick, () =>
    report("unavailable"),
  );
  const unsubscribeRepositories = cloud.onUpdate(
    api.repositoryBindings.forMachine,
    {},
    (value) => {
      if (abort.signal.aborted || removed) return;
      const decoded = Schema.decodeUnknownOption(MachineRepositories)(value);
      if (decoded._tag === "None") {
        report("unavailable");
        return;
      }
      if (isDeepStrictEqual(repositorySnapshot, decoded.value)) return;
      repositorySnapshot = decoded.value;
      onChange();
      // forMachine returns bindings in ascending creation order.
      const bindings = new Set(repositorySnapshot.slice(-20).map((binding) => binding.id));
      for (const [bindingId, unsubscribe] of jobSubscriptions) {
        if (bindings.has(bindingId)) continue;
        unsubscribe();
        jobSubscriptions.delete(bindingId);
        jobValues.delete(bindingId);
      }
      for (const bindingId of bindings) {
        if (jobSubscriptions.has(bindingId)) continue;
        const unsubscribe = cloud.onUpdate(
          api.jobs.list,
          { bindingId },
          (jobs) => {
            if (
              abort.signal.aborted ||
              removed ||
              jobSubscriptions.get(bindingId) !== unsubscribe ||
              isDeepStrictEqual(jobValues.get(bindingId), jobs)
            )
              return;
            jobValues.set(bindingId, jobs);
            onChange();
          },
          () => {
            if (jobSubscriptions.get(bindingId) !== unsubscribe) return;
            jobValues.delete(bindingId);
            report("unavailable");
          },
        );
        jobSubscriptions.set(bindingId, unsubscribe);
      }
    },
    () => report("unavailable"),
  );
  const disconnect = cloud.client.subscribeToConnectionState((state) => {
    if (!state.isWebSocketConnected) report("unavailable");
  });
  interval = setInterval(tick, 2000);
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
    watchLeases(ids: readonly string[]) {
      if (abort.signal.aborted || removed) return;
      const leaseIds = [...new Set(ids)].sort();
      if (isDeepStrictEqual(watchedLeaseIds, leaseIds)) return;
      if (leaseIds.length > 20)
        throw new VectisError("invalid_lease_ids", "Watch at most 20 runner leases.");
      unsubscribeLeases?.();
      unsubscribeLeases = undefined;
      watchedLeaseIds = leaseIds;
      if (!leaseIds.length) return;
      unsubscribeLeases = cloud.onUpdate(
        api.jobs.forLeases,
        { leaseIds },
        (value) => {
          if (abort.signal.aborted || removed || watchedLeaseIds !== leaseIds) return;
          const decoded = Schema.decodeUnknownOption(JobObservations)(value);
          if (decoded._tag === "None") {
            report("unavailable");
            return;
          }
          onJobObservations(decoded.value);
        },
        () => {
          if (watchedLeaseIds === leaseIds) report("unavailable");
        },
      );
    },
    get repositorySnapshot() {
      return repositorySnapshot;
    },
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
        cloud.action(api.githubRepositories.connectMachine, {
          accountId: input.accountId,
          environmentId: input.environmentId,
          repositoryName: input.repositoryName,
          ...(input.repositoryOwner === undefined
            ? {}
            : { repositoryOwner: input.repositoryOwner }),
        }),
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60000)]),
      );
    },
    async disconnectRepository(bindingId: string) {
      requireConnection();
      await interruptible(
        cloud.mutation(api.repositoryBindings.disconnectForMachine, { bindingId }),
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
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
      const cached = jobValues.get(bindingId);
      if (cached !== undefined && !removed && cloud.client.connectionState().isWebSocketConnected)
        return cached;
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
      if (interval) clearInterval(interval);
      unsubscribe();
      unsubscribeInspections();
      unsubscribeRepositories();
      unsubscribeLeases?.();
      for (const unsubscribe of jobSubscriptions.values()) unsubscribe();
      jobSubscriptions.clear();
      jobValues.clear();
      disconnect();
      await cloud.close();
      await pendingToken?.catch(() => {});
      await active;
    },
  };
}
