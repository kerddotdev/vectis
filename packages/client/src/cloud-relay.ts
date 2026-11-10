import { ScaleSetGrant, type CapacityMode } from "../../protocol/src/scale-sets.js";
import { RunControlOutcome, type RunControlCommand } from "../../protocol/src/runs.js";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { environmentRevision } from "./environment-revision.js";
import {
  CloudRepositoryReadiness,
  type RepositoryReadinessInput,
} from "../../protocol/src/readiness.js";
import { MigrationAnalysis, MigrationPublication } from "../../protocol/src/migrations.js";
import type { RepositoryAccess } from "../../protocol/src/repository-access.js";
import type { MachineRepositories, RepositoryConnection } from "../../protocol/src/repositories.js";
import {
  JobLogs,
  type JobLogRequest,
  JobRefresh,
  JobScan,
  type JobObservations,
  type Jobs,
} from "../../protocol/src/jobs.js";
import {
  RunnerGrant,
  RunnerLease,
  RunnerStatus,
  type RunnerBroker,
} from "../../protocol/src/runners.js";
import { VectisError } from "../../protocol/src/index.js";
import type { MachinePath, MachineRequest, RemoteOperation } from "../../protocol/src/cloud.js";
import { answerInspection } from "./inspection.js";
import { advanceRemoteOperation } from "./remote-operation.js";
import { machineBearer, type CloudConnection } from "./machine-auth.js";
import { createCloudApi, removalCodes } from "./cloud-api.js";
import { createCloudSocket, type StatusFields, type SocketConstructor } from "./cloud-socket.js";
import type { KeychainCredentials } from "./keychain.js";
import type { VectisClient } from "./index.js";
function decodeScaleSetGrant(value: unknown) {
  try {
    return Schema.decodeUnknownSync(ScaleSetGrant)(value);
  } catch {
    throw new VectisError(
      "scale_set_protocol_invalid",
      "The cloud returned an invalid scale set grant.",
    );
  }
}

export function startCloudRelay(
  connection: CloudConnection,
  local: VectisClient,
  credentials: Pick<KeychainCredentials, "get">,
  onState: (state: "connecting" | "connected" | "unavailable" | "removed") => void,
  onChange: () => void,
  onJobObservations: (entries: JobObservations) => void,
  transport: { fetch?: typeof fetch; WebSocket?: SocketConstructor } = {},
) {
  const abort = new AbortController();
  const api = createCloudApi(connection, credentials, transport.fetch);
  let removed = false;
  let active: Promise<void> | undefined;
  let rerun = false;
  let synced = false;
  let generation = 0;
  let syncRetry: ReturnType<typeof setTimeout> | undefined;
  let syncAttempt = 0;
  const remoteOperations = new Map<string, RemoteOperation>();
  let advancing: Promise<void> | undefined;
  function progressOperations() {
    advancing ??= (async () => {
      for (const remote of remoteOperations.values())
        await advanceRemoteOperation(
          remote,
          local,
          async (args) => {
            try {
              await call("/machine/operations/acknowledge", args);
            } catch (error) {
              if (error instanceof VectisError && error.code === "operation_cancelled")
                remoteOperations.delete(remote.id);
              throw error;
            }
            if (["claimed", "running"].includes(args.phase))
              remoteOperations.set(remote.id, { ...remote, phase: args.phase });
            else remoteOperations.delete(remote.id);
          },
          abort.signal,
        );
    })().finally(() => {
      advancing = undefined;
    });
    return advancing;
  }
  let scanOnSync = true;
  let repositorySnapshot: MachineRepositories | undefined;
  let watchedLeaseIds: readonly string[] = [];
  const jobMarkers = new Map<string, { value: number | null }>();
  const jobLists = new Map<string, { marker: { value: number | null }; jobs: Jobs }>();
  const scanTimers = new Set<ReturnType<typeof setTimeout>>();
  const report = (state: "connecting" | "connected" | "unavailable") => {
    if (!removed && !abort.signal.aborted) onState(state);
  };
  function machineRemoved() {
    if (removed || abort.signal.aborted) return;
    removed = true;
    onState("removed");
    stop();
  }
  function failed(error: unknown) {
    if (error instanceof VectisError && removalCodes.includes(error.code)) machineRemoved();
    else report("unavailable");
  }
  async function call<P extends MachinePath>(
    path: P,
    input: MachineRequest<P>,
    signal: AbortSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  ) {
    try {
      return await api.call(path, input, AbortSignal.any([signal, abort.signal]));
    } catch (error) {
      if (error instanceof VectisError && removalCodes.includes(error.code)) machineRemoved();
      throw error;
    }
  }
  async function status(): Promise<StatusFields> {
    const snapshot = await local.status(abort.signal);
    if (connection.localId !== snapshot.machine.id)
      throw new VectisError(
        "machine_identity_mismatch",
        "This credential belongs to another local machine.",
      );
    const environments = await Promise.all(
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
    );
    environments.sort((a, b) => a.id.localeCompare(b.id));
    return {
      paused: snapshot.machine.paused,
      ...(snapshot.runnerCapacity
        ? {
            runnerSlots: snapshot.runnerCapacity.available,
            ...(snapshot.runnerCapacity.environments
              ? { environmentSlots: snapshot.runnerCapacity.environments.slice(0, 100) }
              : {}),
          }
        : {}),
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
              ].includes(operation.command) && ["accepted", "running"].includes(operation.status),
        ),
      environments,
    };
  }
  function scheduleScans() {
    const hour = Math.floor(Date.now() / 3600000);
    for (const [index, binding] of (repositorySnapshot ?? [])
      .filter((binding) => binding.automatic)
      .entries()) {
      const timer = setTimeout(() => {
        scanTimers.delete(timer);
        if (
          !removed &&
          !abort.signal.aborted &&
          repositorySnapshot?.some((item) => item.id === binding.id && item.automatic)
        )
          void local
            .submit(
              { type: "job.scan", bindingId: binding.id, automatic: true },
              `cloud-scan:${binding.id}:${hour}`,
              abort.signal,
            )
            .catch(failed);
      }, index * 3000);
      scanTimers.add(timer);
    }
  }
  async function reconcile() {
    const connectedGeneration = generation;
    await advancing;
    await socket.refreshStatus();
    const leaseIds = watchedLeaseIds;
    const snapshot = await call("/machine/sync", { leaseIds });
    if (abort.signal.aborted || removed) return;
    for (const binding of snapshot.repositories) {
      const previous = repositorySnapshot?.find((item) => item.id === binding.id);
      if (!isDeepStrictEqual(previous?.access, binding.access)) {
        jobMarkers.delete(binding.id);
        jobLists.delete(binding.id);
      }
    }
    if (!isDeepStrictEqual(repositorySnapshot, snapshot.repositories)) {
      repositorySnapshot = snapshot.repositories;
      onChange();
    }
    const ids = new Set(snapshot.repositories.slice(-20).map((binding) => binding.id));
    for (const id of jobMarkers.keys())
      if (!ids.has(id)) {
        jobMarkers.delete(id);
        jobLists.delete(id);
      }
    for (const id of ids) {
      const value = snapshot.jobMarkers[id];
      if (value === undefined) {
        jobMarkers.delete(id);
        jobLists.delete(id);
      } else if (!jobMarkers.has(id) || jobMarkers.get(id)?.value !== value) {
        jobMarkers.set(id, { value });
        onChange();
      }
    }
    if (watchedLeaseIds === leaseIds) onJobObservations(snapshot.observations);
    await advancing;
    remoteOperations.clear();
    for (const operation of snapshot.operations) remoteOperations.set(operation.id, operation);
    await progressOperations();
    for (const inspection of snapshot.inspections.slice(0, 2)) {
      const responseJson = await answerInspection(inspection.queryJson, local, abort.signal);
      await call("/machine/inspections/respond", { id: inspection.id, responseJson });
    }
    synced = connectedGeneration === generation && socket.open;
    if (synced) report("connected");
    clearTimeout(syncRetry);
    syncRetry = undefined;
    syncAttempt = 0;
    if (scanOnSync) {
      scanOnSync = false;
      scheduleScans();
    }
  }
  function sync(): Promise<void> {
    if (removed || abort.signal.aborted) return Promise.resolve();
    if (active) {
      rerun = true;
      return active;
    }
    active = (async () => {
      do {
        rerun = false;
        await reconcile();
      } while (rerun && !abort.signal.aborted && !removed);
    })().finally(() => {
      active = undefined;
    });
    return active;
  }
  const tick = () => {
    void sync().catch((error) => {
      failed(error);
      if (!removed && !abort.signal.aborted && !syncRetry)
        syncRetry = setTimeout(
          () => {
            syncRetry = undefined;
            tick();
          },
          Math.min(60000, 1000 * 2 ** Math.min(syncAttempt++, 6)) * (0.5 + Math.random() * 0.5),
        );
    });
  };
  report("connecting");
  const socket = createCloudSocket({
    url: connection.deploymentUrl,
    bearer: async () => {
      const bearer = await machineBearer(connection, credentials, abort.signal);
      if (!bearer)
        throw new VectisError("machine_revoked", "The machine credential is no longer available.");
      return bearer;
    },
    status,
    onOpen: () => {
      generation++;
      synced = false;
      scanOnSync = true;
      tick();
    },
    onChanged: tick,
    onLoss: (error) => {
      generation++;
      synced = false;
      failed(error);
    },
    onRemoved: machineRemoved,
    ...(transport.WebSocket ? { WebSocket: transport.WebSocket } : {}),
  });
  const statusTimer = setInterval(() => {
    if (!removed) {
      void socket.refreshStatus().catch(failed);
      if (!active && socket.open && remoteOperations.size) void progressOperations().catch(failed);
    }
  }, 5000);
  const syncTimer = setInterval(tick, 15 * 60 * 1000);
  const scanTimer = setInterval(() => {
    if (synced && socket.open) scheduleScans();
    else scanOnSync = true;
  }, 3600000);
  function stop() {
    abort.abort();
    socket.close();
    clearTimeout(syncRetry);
    syncRetry = undefined;
    clearInterval(statusTimer);
    clearInterval(syncTimer);
    clearInterval(scanTimer);
    for (const timer of scanTimers) clearTimeout(timer);
    scanTimers.clear();
    jobMarkers.clear();
    jobLists.clear();
  }
  function requireConnection() {
    if (abort.signal.aborted || removed || !socket.open)
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
      if (leaseIds.length > 20)
        throw new VectisError("invalid_lease_ids", "Watch at most 20 runner leases.");
      if (!isDeepStrictEqual(watchedLeaseIds, leaseIds)) {
        watchedLeaseIds = leaseIds;
        tick();
      }
    },
    get repositorySnapshot() {
      return repositorySnapshot;
    },
    async analyzeMigration(bindingId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await call(
        "/machine/migrations/analyze",
        { bindingId },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(MigrationAnalysis)(result);
    },
    async publishMigration(previewId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await call(
        "/machine/migrations/publish",
        { previewId },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(MigrationPublication)(result);
    },
    async repositoryReadiness(input: RepositoryReadinessInput) {
      requireConnection();
      return Schema.decodeUnknownSync(CloudRepositoryReadiness)(
        await call(
          "/machine/repositories/readiness",
          { input },
          AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        ),
      );
    },
    async githubAccounts() {
      requireConnection();
      return call(
        "/machine/github/accounts",
        {},
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async connectRepository(input: RepositoryConnection, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      await socket.waitForEnvironment(
        input.environmentId,
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(10000)]),
      );
      return call(
        "/machine/repositories/connect",
        {
          accountId: input.accountId,
          environmentId: input.environmentId,
          repositoryName: input.repositoryName,
          ...(input.repositoryOwner === undefined
            ? {}
            : { repositoryOwner: input.repositoryOwner }),
        },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      )
        .then((result) => result.bindingId)
        .catch((error: unknown) => {
          if (error instanceof VectisError && error.code !== "cloud_unavailable") throw error;
          throw new VectisError(
            "repository_connection_unconfirmed",
            "Repository connection could not be confirmed.",
            "List repository connections before retrying; then check readiness for the account, environment and GitHub App access.",
          );
        });
    },
    async disconnectRepository(bindingId: string) {
      requireConnection();
      await call(
        "/machine/repositories/disconnect",
        { bindingId },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async setAutomatic(bindingId: string, enabled: boolean) {
      requireConnection();
      await call(
        "/machine/repositories/set-automatic",
        { bindingId, enabled },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async setInfraRerun(bindingId: string, enabled: boolean) {
      requireConnection();
      await call(
        "/machine/repositories/set-infra-rerun",
        { bindingId, enabled },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async setCapacityMode(bindingId: string, capacityMode: CapacityMode) {
      requireConnection();
      await call(
        "/machine/repositories/set-capacity-mode",
        {
          bindingId,
          capacityMode,
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async openScaleSet(bindingId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      return decodeScaleSetGrant(
        await call(
          "/machine/scale-sets/open",
          { bindingId },
          AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
        ),
      );
    },
    async refreshScaleSet(bindingId: string, generation: number, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      return decodeScaleSetGrant(
        await call(
          "/machine/scale-sets/refresh",
          { bindingId, generation },
          AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
        ),
      );
    },
    async closeScaleSet(bindingId: string, generation: number, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      await call(
        "/machine/scale-sets/close",
        { bindingId, generation },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async controlRun(command: RunControlCommand, key: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await call(
        "/machine/runs/control",
        { command, key },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(RunControlOutcome)(result);
    },
    async setCacheVolume(bindingId: string, cacheVolume: { enabled: boolean; sizeGiB?: number }) {
      requireConnection();
      await call(
        "/machine/repositories/set-cache-volume",
        { bindingId, ...cacheVolume },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async setAccess(bindingId: string, access: RepositoryAccess) {
      requireConnection();
      await call(
        "/machine/repositories/set-access",
        {
          bindingId,
          actors: access.actors === "any" ? "any" : { ids: [...access.actors.ids] },
          approval: access.approval,
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      );
    },
    async scanJobs(bindingId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await call(
        "/machine/jobs/scan",
        { bindingId },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(JobScan)(result);
    },
    async refreshJob(bindingId: string, jobId: number, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const result = await call(
        "/machine/jobs/refresh",
        { bindingId, jobId },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(JobRefresh)(result);
    },
    async jobLogs(input: JobLogRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      requireConnection();
      return Schema.decodeUnknownSync(JobLogs)(
        await call(
          "/machine/jobs/logs",
          {
            bindingId: input.bindingId,
            jobId: input.jobId,
            ...(input.after === undefined ? {} : { after: input.after }),
          },
          AbortSignal.any([...(signal ? [signal] : []), abort.signal, AbortSignal.timeout(60000)]),
        ),
      );
    },
    async jobs(bindingId: string) {
      requireConnection();
      const marker = jobMarkers.get(bindingId);
      const cached = jobLists.get(bindingId);
      if (marker !== undefined && cached?.marker === marker && !removed && socket.open)
        return cached.jobs;
      try {
        const jobs = await call(
          "/machine/jobs/list",
          { bindingId },
          AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        );
        if (marker !== undefined) jobLists.set(bindingId, { marker, jobs });
        return jobs;
      } catch {
        throw new VectisError(
          "job_access_unavailable",
          "Repository job state could not be read.",
          "Check this machine's repository binding and cloud connection, then retry.",
        );
      }
    },
    async reconcileRunner(
      request: Parameters<RunnerBroker["reconcileRunner"]>[0],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      requireConnection();
      const value = await call(
        "/machine/runners/reconcile",
        request,
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(10000)]),
      );
      return Schema.decodeUnknownSync(RunnerLease)(value);
    },
    async prepareRunner(
      bindingId: string,
      key: string,
      signal: AbortSignal,
      request?: Parameters<RunnerBroker["prepareRunner"]>[3],
    ) {
      signal.throwIfAborted();
      requireConnection();
      const value = await call(
        "/machine/runners/prepare",
        { bindingId, key, ...request },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(RunnerGrant)(value);
    },
    async runnerStatus(leaseId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      const value = await call(
        "/machine/runners/status",
        { id: leaseId },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
      return Schema.decodeUnknownSync(RunnerStatus)(value);
    },
    async releaseRunner(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      requireConnection();
      await call(
        "/machine/runners/release",
        { id },
        AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180000)]),
      );
    },
    async repositories() {
      requireConnection();
      try {
        await sync();
        return repositorySnapshot ?? [];
      } catch {
        throw new VectisError(
          "repository_access_unavailable",
          "Repository access could not be verified.",
          "Check the machine connection and linked GitHub account, then retry.",
        );
      }
    },
    async close() {
      stop();
      await active?.catch(() => {});
      await advancing?.catch(() => {});
    },
  };
}
