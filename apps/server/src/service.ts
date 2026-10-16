import type { RunControlBroker } from "../../../packages/protocol/src/runs.js";
import { unconfirmedRunCommand } from "../../../packages/github/src/run-control.js";
import { repositoryReadiness } from "./repository-readiness.js";
import type {
  CloudRepositoryReadiness,
  RepositoryReadiness,
  RepositoryReadinessInput,
} from "../../../packages/protocol/src/readiness.js";
import { environmentNetwork } from "../../../packages/runner/src/environment-network.js";
import { inspect } from "node:util";
import { redact } from "../../../packages/client/src/redact.js";
import { startMacGuestAccess, completedMacEnvironment } from "./macos-access-task.js";
import { discardMacInstallation } from "./macos-discard.js";
import {
  startWindowsInstallation,
  recoverWindowsInstallations,
  hasUnconfirmedWindowsInstallation,
} from "./windows-installation-task.js";
import type { SetupCredentials } from "../../../packages/runner/src/windows-media.js";
import { completeMacRegistration } from "./macos-registration.js";
import {
  startMacInstallation,
  recoverMacInstallations,
  hasUnconfirmedMacInstallation,
} from "./macos-installation-task.js";
import { preparationDirectory } from "../../../packages/runner/src/linux-preparation.js";
import { startPreparation } from "./preparation-task.js";
import { preparationStopped } from "../../../packages/runner/src/preparation-process.js";
import type {
  MigrationAnalysis,
  MigrationPublication,
} from "../../../packages/protocol/src/migrations.js";
import { matchesRunnerLabels } from "../../../packages/github/src/runner-labels.js";
import { setTimeout as delay } from "node:timers/promises";
import type {
  JobLogRequest,
  JobLogs,
  JobRefresh,
  JobScan,
  JobObservations,
} from "../../../packages/protocol/src/jobs.js";
import { RunnerProgress, type RunnerBroker } from "../../../packages/protocol/src/runners.js";
import type {
  MachineRepositories,
  RepositoryConnection,
} from "../../../packages/protocol/src/repositories.js";
import { runRunnerTask } from "./runner-task.js";
import { createHash, randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { Schema } from "effect";
import {
  Command,
  ActivityJob,
  Environment,
  Preparation,
  VectisError,
  type Operation,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";
import { previewMigration } from "../../../packages/migration/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Store } from "./store.js";
import { activityFor, decidingMember, type ActivityLink } from "./activities.js";
import { retainActivities } from "./activity-retention.js";
import { observeRunnerJobs, watchRunnerJobs } from "./runner-job-observations.js";
import { instanceAdmissionError, runnerCapacity } from "./runner-capacity.js";

import type { RepositoryAccess } from "../../../packages/protocol/src/repository-access.js";
import { jobAccess, restrictiveAccess } from "../../../packages/github/src/access-policy.js";

export class Service {
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private preparing: string | undefined;
  private tasks = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupSweep: Promise<void> | undefined;
  private cleanupAbort = new AbortController();
  private retentionTimer: ReturnType<typeof setInterval> | undefined;
  private stopWatchingJobs: () => void;
  constructor(
    readonly store: Store,
    readonly runtime: VmRuntime,
    readonly runnerConnection: () => RunnerBroker &
      RunControlBroker & {
        analyzeMigration(bindingId: string, signal: AbortSignal): Promise<MigrationAnalysis>;
        publishMigration(previewId: string, signal: AbortSignal): Promise<MigrationPublication>;
        repositories(): Promise<MachineRepositories>;
        connectRepository(input: RepositoryConnection, signal: AbortSignal): Promise<string>;
        disconnectRepository(bindingId: string): Promise<void>;
        setAutomatic(bindingId: string, enabled: boolean): Promise<void>;
        jobLogs(input: JobLogRequest, signal?: AbortSignal): Promise<JobLogs>;
        setAccess(bindingId: string, access: RepositoryAccess): Promise<void>;
        scanJobs(bindingId: string, signal: AbortSignal): Promise<JobScan>;
        refreshJob(bindingId: string, jobId: number, signal: AbortSignal): Promise<JobRefresh>;
      } = () => {
      throw new VectisError("cloud_unconfigured", "Connect this machine before starting runners.");
    },
    readonly setupCredentials?: SetupCredentials,
    readonly repositorySnapshot: () => MachineRepositories | undefined = () => undefined,
    watchLeases: (ids: readonly string[]) => void = () => {},
    readonly runnerCleanup: { intervalMs?: number; connected: () => boolean } = {
      connected: () => false,
    },
  ) {
    store.recover();
    this.stopWatchingJobs = watchRunnerJobs(store, watchLeases);
  }
  async jobLogs(input: JobLogRequest, signal?: AbortSignal) {
    return this.runnerConnection().jobLogs(input, signal);
  }
  observeJobs(observations: JobObservations) {
    observeRunnerJobs(this.store, observations);
  }
  snapshot(): Snapshot {
    const repositories = this.repositorySnapshot();
    const snapshot = this.store.snapshot();
    return {
      ...snapshot,
      environments: snapshot.environments.map((environment) => ({
        ...environment,
        network: environmentNetwork(environment),
      })),
      runnerCapacity: runnerCapacity(snapshot, { cpus: cpus().length, memoryBytes: totalmem() }),
      ...(repositories === undefined ? {} : { repositories }),
    };
  }
  repositoryReadiness(
    input: RepositoryReadinessInput,
    readCloud: (input: RepositoryReadinessInput) => Promise<CloudRepositoryReadiness>,
  ): Promise<RepositoryReadiness> {
    return repositoryReadiness(input, () => this.store.snapshot().environments, readCloud);
  }
  async initialize() {
    await recoverWindowsInstallations(this.store);
    await recoverMacInstallations(this.store);
    for (const environment of this.store.snapshot().environments) {
      if (
        environment.os === "linux" &&
        environment.sshUser &&
        environment.sshHostKeyMode !== "instance" &&
        environment.state === "ready"
      )
        this.store.put("environment", environment.id, { ...environment, state: "action_required" });
    }
    for (const value of this.store.list("preparation")) {
      const preparation = Schema.decodeUnknownSync(Preparation)(value);
      if (
        preparation.phase === "booting" &&
        (await preparationStopped(preparationDirectory(preparation), preparation.id))
      )
        this.store.put("preparation", preparation.id, { ...preparation, phase: "interrupted" });
    }
    for (const instance of this.store.snapshot().instances) {
      if (
        instance.status === "interrupted" &&
        (await this.runtime.reconcile(instance.id, instance.directory))
      )
        this.store.put("instance", instance.id, { ...instance, status: "stopped", pid: 0 });
    }
    if (!this.closing && !this.retentionTimer) {
      const sweep = () => retainActivities(this.store, (id) => this.tasks.has(id));
      sweep();
      this.retentionTimer = setInterval(
        () => {
          try {
            sweep();
          } catch (error) {
            console.error("Activity retention failed:", redact(inspect(error)));
          }
        },
        60 * 60 * 1000,
      );
      this.retentionTimer.unref();
    }
    if (!this.closing && !this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        if (this.closing || this.cleanupSweep || !this.runnerCleanup.connected()) return;
        this.cleanupSweep = this.retryRunnerCleanup()
          .catch((error) => {
            console.error("Runner cleanup retry failed:", redact(inspect(error)));
          })
          .finally(() => {
            this.cleanupSweep = undefined;
          });
      }, this.runnerCleanup.intervalMs ?? 60000);
      this.cleanupTimer.unref();
    }
  }
  private async retryRunnerCleanup() {
    for (const operation of this.store.snapshot().operations) {
      if (this.closing || !this.runnerCleanup.connected()) break;
      if (
        operation.command !== "runner.run" ||
        operation.status !== "action_required" ||
        this.tasks.has(operation.id) ||
        !(Date.now() - Date.parse(operation.updatedAt) < 30 * 60 * 1000) ||
        !Schema.is(Schema.Struct({ code: Schema.Literal("runner_cleanup_required") }))(
          operation.result,
        )
      )
        continue;
      try {
        await this.reconcileRunner(operation.id);
      } catch {
        // Keep the original update time so failures cannot extend the retry window.
      }
    }
  }
  submit(key: string, command: Command): Operation {
    const operationId = randomUUID();
    return this.acceptSubmission(operationId, key, command, activityFor(operationId, command));
  }
  private submitChild(activityId: string, key: string, command: Command): Operation {
    return this.acceptSubmission(randomUUID(), key, command, { activityId });
  }
  private acceptSubmission(
    operationId: string,
    key: string,
    command: Command,
    link?: ActivityLink,
  ): Operation {
    if (this.closing && command.type !== "instance.stop")
      throw new VectisError("service_stopping", "The service is stopping.");
    if (key.length > 200) throw new VectisError("invalid_request", "The request key is too long.");
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const accepted = this.store.accept(key, fingerprint, command.type, link, operationId);
    if (accepted.fresh)
      this.queue = this.queue.then(() => this.execute(accepted.operation, command));
    return accepted.operation;
  }
  private closeWaitingOperation(waiting: Operation | undefined) {
    if (!waiting || waiting.status !== "action_required")
      throw new VectisError(
        "operation_not_cancellable",
        "No active cancellable task has this operation ID.",
      );
    if (waiting.command === "runner.run")
      throw new VectisError(
        "operation_not_cancellable",
        "An interrupted runner is reconciled, not closed.",
        "Confirm the VM stopped, then run runner reconcile with this operation ID.",
      );
    if (Schema.is(Schema.Struct({ setupId: Schema.String }))(waiting.result))
      throw new VectisError(
        "operation_not_cancellable",
        "This image preparation still owns a setup.",
        "Resume the preparation, or discard it, instead of closing its operation.",
      );
    this.store.update(waiting, {
      status: "cancelled",
      message: "Closed without confirming its result.",
    });
    return { operationId: waiting.id, closed: true };
  }
  private async reconcileRunner(id: string) {
    this.cleanupAbort.signal.throwIfAborted();
    const snapshot = this.store.snapshot();
    const interrupted = snapshot.operations.find((item) => item.id === id);
    if (
      !interrupted ||
      interrupted.command !== "runner.run" ||
      interrupted.status !== "action_required" ||
      this.tasks.has(id)
    )
      throw new VectisError(
        "reconciliation_required",
        "Only an interrupted runner operation can be reconciled.",
      );
    const progress = Schema.decodeUnknownSync(RunnerProgress)(interrupted.result);
    const start = snapshot.operations.find((item) => item.key === `${interrupted.id}:start`);
    const instance = snapshot.instances.find(
      (item) => item.id === (progress.instanceId ?? start?.id),
    );
    if (instance && instance.status !== "stopped")
      throw new VectisError(
        "reconciliation_required",
        "The runner VM must be verified stopped first.",
        "Stop or reconcile the owned instance, then retry runner reconciliation.",
      );
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.cleanupAbort.signal]);
    const work = (async () => {
      const broker = this.runnerConnection();
      const lease = await broker.reconcileRunner(
        {
          bindingId: progress.bindingId,
          environmentId: progress.environmentId,
          key: progress.leaseKey,
        },
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      if (
        lease.bindingId !== progress.bindingId ||
        lease.environmentId !== progress.environmentId ||
        (progress.leaseId && lease.id !== progress.leaseId)
      )
        throw new VectisError(
          "runner_identity_mismatch",
          "The cloud lease does not match this operation.",
        );
      signal.throwIfAborted();
      if (lease.phase !== "released")
        await broker.releaseRunner(lease.id, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
      signal.throwIfAborted();
      this.store.update(interrupted, {
        status: progress.cause ? "failed" : "cancelled",
        message:
          progress.cause?.message ??
          "Interrupted runner cleaned up. Check GitHub for the job result.",
        result: {
          ...progress,
          leaseId: lease.id,
          stage: "finished",
          ...(progress.cause ? { code: progress.cause.code } : {}),
        },
      });
      return { operationId: interrupted.id, leaseId: lease.id };
    })().finally(() => {
      this.tasks.delete(id);
    });
    this.tasks.set(id, {
      abort,
      done: work.then(
        () => {},
        () => {},
      ),
    });
    return work;
  }

  private async execute(operation: Operation, command: Command) {
    operation = this.store.update(operation, { status: "running", message: "Running." });
    try {
      let result: unknown;
      const snapshot = this.store.snapshot();
      if (
        (this.preparing || snapshot.preparationBusy) &&
        [
          "environment.register",
          "environment.configure",
          "environment.remove",
          "environment.start",
        ].includes(command.type)
      )
        throw new VectisError(
          "preparation_active",
          "Finish or cancel the active image preparation before changing environments or starting VMs.",
        );
      switch (command.type) {
        case "environment.install-windows":
        case "environment.resume-windows": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          if (this.preparing)
            throw new VectisError("preparation_busy", "An image preparation is already active.");
          const active = await startWindowsInstallation(
            this.store,
            this.runtime,
            operation,
            command,
            this.setupCredentials,
          );
          this.preparing = operation.id;
          const done = active.done.finally(() => {
            this.preparing = undefined;
            this.tasks.delete(operation.id);
          });
          this.tasks.set(operation.id, { abort: active.abort, done });
          return;
        }
        case "environment.connect-macos-guest":
        case "environment.verify-macos-guest": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const active = await startMacGuestAccess(this.store, operation, command);
          const done = active.done.finally(() => this.tasks.delete(operation.id));
          this.tasks.set(operation.id, { abort: active.abort, done });
          return;
        }
        case "environment.finish-macos-setup": {
          if (this.preparing || snapshot.preparationBusy)
            throw new VectisError(
              "preparation_active",
              "Shut down the guest setup before registering it.",
            );
          const environment = await completedMacEnvironment(this.store, command.id);
          if (snapshot.environments.some((item) => item.id === environment.id))
            throw new VectisError("environment_exists", "This environment is already registered.");
          await this.runtime.validate(environment);
          this.store.put("environment", environment.id, environment);
          completeMacRegistration(this.store, environment);
          result = { environment };
          break;
        }
        case "environment.discard-macos": {
          if (this.preparing)
            throw new VectisError(
              "preparation_active",
              "Stop the active setup before discarding it.",
            );
          result = await discardMacInstallation(this.store, command.id, command.environmentId);
          break;
        }
        case "environment.install-macos":
        case "environment.resume-macos":
        case "environment.open-macos-setup": {
          if (hasUnconfirmedWindowsInstallation(this.store))
            throw new VectisError(
              "reconciliation_required",
              "A Windows installer needs exit verification.",
            );
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          if (this.preparing)
            throw new VectisError("preparation_busy", "An image preparation is already active.");
          const active = await startMacInstallation(this.store, this.runtime, operation, command);
          this.preparing = operation.id;
          const done = active.done.finally(() => {
            this.preparing = undefined;
            this.tasks.delete(operation.id);
          });
          this.tasks.set(operation.id, { abort: active.abort, done });
          return;
        }
        case "environment.prepare-linux":
        case "environment.resume": {
          if (
            hasUnconfirmedMacInstallation(this.store) ||
            hasUnconfirmedWindowsInstallation(this.store)
          )
            throw new VectisError(
              "reconciliation_required",
              "A guest installer needs exit verification.",
            );
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          if (this.preparing)
            throw new VectisError("preparation_busy", "An image preparation is already active.");
          const active = await startPreparation(this.store, this.runtime, operation, command);
          this.preparing = active.setupId;
          const done = active.done.finally(() => {
            this.preparing = undefined;
            this.tasks.delete(operation.id);
          });
          this.tasks.set(operation.id, { abort: active.abort, done });
          return;
        }
        case "migration.analyze":
        case "migration.publish": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const broker = this.runnerConnection();
          const abort = new AbortController();
          const publishing = command.type === "migration.publish";
          const request =
            command.type === "migration.analyze"
              ? broker.analyzeMigration(command.bindingId, abort.signal)
              : broker.publishMigration(command.previewId, abort.signal);
          const done = request
            .then((result) => {
              this.store.update(operation, {
                status: "succeeded",
                message: publishing
                  ? "Migration PR observed on GitHub. No merge was performed."
                  : "Migration preview prepared. Review the findings before publication.",
                result,
              });
            })
            .catch(() => {
              this.store.update(operation, {
                status: publishing
                  ? "action_required"
                  : abort.signal.aborted
                    ? "cancelled"
                    : "failed",
                message: publishing
                  ? "Migration publication could not be confirmed."
                  : "Migration analysis did not complete.",
                result: {
                  code: publishing
                    ? "migration_publication_unconfirmed"
                    : "migration_analysis_failed",
                  nextStep: publishing
                    ? "Inspect the existing Vectis PR and branch, confirm runner verification and App permissions, then retry the same preview. Never merge automatically."
                    : "Check repository access and prepared environment availability, then retry the analysis.",
                },
              });
            })
            .finally(() => {
              this.tasks.delete(operation.id);
            });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "repository.connect": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const environment = snapshot.environments.find(
            (item) => item.id === command.environmentId,
          );
          if (environment?.state !== "ready")
            throw new VectisError(
              environment ? "setup_required" : "environment_unavailable",
              environment
                ? "Prepare the local environment before connecting a repository."
                : "The selected environment is unavailable on this machine.",
              "Select a local environment and complete its preparation before connecting the repository.",
            );
          const broker = this.runnerConnection();
          const abort = new AbortController();
          const done = broker
            .connectRepository(
              {
                accountId: command.accountId,
                repositoryName: command.repositoryName,
                ...(command.repositoryOwner ? { repositoryOwner: command.repositoryOwner } : {}),
                environmentId: command.environmentId,
              },
              abort.signal,
            )
            .then((bindingId) => {
              this.store.update(operation, {
                status: "succeeded",
                message: "Repository connected.",
                result: { bindingId },
              });
            })
            .catch((error: unknown) => {
              // Refused and unconfirmed attempts have no resumable local work. Keep uncertain cloud
              // effects unconfirmed so the caller inspects bindings before retrying.
              this.store.update(operation, {
                status: "failed",
                message:
                  error instanceof VectisError
                    ? error.message
                    : "Repository connection could not be confirmed.",
                result: {
                  code:
                    error instanceof VectisError ? error.code : "repository_connection_unconfirmed",
                  nextStep:
                    error instanceof VectisError
                      ? error.nextStep
                      : "List repository connections before retrying; then check the account, environment and GitHub App access.",
                },
              });
            })
            .finally(() => {
              this.tasks.delete(operation.id);
            });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "repository.disconnect": {
          await this.runnerConnection().disconnectRepository(command.bindingId);
          result = { bindingId: command.bindingId, connected: false };
          break;
        }
        case "repository.access": {
          const access = {
            actors:
              command.actors === "any"
                ? ("any" as const)
                : { ids: [...new Set(command.actors.ids)] },
            approval: command.approval,
          };
          await this.runnerConnection().setAccess(command.bindingId, access);
          result = { bindingId: command.bindingId, access };
          break;
        }
        case "repository.automatic": {
          await this.runnerConnection().setAutomatic(command.bindingId, command.enabled);
          result = { bindingId: command.bindingId, automatic: command.enabled };
          break;
        }
        case "run.rerun-failed":
        case "run.cancel":
        case "workflow.dispatch": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const broker = this.runnerConnection();
          const abort = new AbortController();
          const done = broker
            .controlRun(command, operation.key, abort.signal)
            .catch((error: unknown) =>
              error instanceof VectisError && error.code !== "run_command_unconfirmed"
                ? {
                    state: "rejected" as const,
                    code: error.code,
                    message: error.message,
                    nextStep: error.nextStep,
                  }
                : unconfirmedRunCommand(command),
            )
            .then((outcome) => {
              this.store.update(operation, {
                status:
                  outcome.state === "accepted"
                    ? "succeeded"
                    : outcome.state === "uncertain" ||
                        (outcome.state === "rejected" &&
                          outcome.code === "github_app_permission_required")
                      ? "action_required"
                      : "failed",
                message: outcome.message,
                result: outcome,
              });
            })
            .finally(() => this.tasks.delete(operation.id));
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "job.scan":
        case "job.refresh": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const broker = this.runnerConnection();
          const abort = new AbortController();
          const request =
            command.type === "job.scan"
              ? broker.scanJobs(command.bindingId, abort.signal)
              : broker.refreshJob(command.bindingId, command.jobId, abort.signal);
          const done = request
            .then((result) => {
              this.store.update(operation, {
                status: "complete" in result && !result.complete ? "action_required" : "succeeded",
                message:
                  "complete" in result && !result.complete
                    ? "GitHub scan reached its bounded API limit. Some jobs may still be missing."
                    : "GitHub job state refreshed.",
                result,
              });
            })
            .catch((error: unknown) => {
              const githubFailure =
                error instanceof VectisError &&
                ["github_unavailable", "github_rate_limited"].includes(error.code)
                  ? error
                  : undefined;
              this.store.update(operation, {
                status: abort.signal.aborted ? "cancelled" : "failed",
                message: abort.signal.aborted
                  ? "Stopped waiting for GitHub job refresh."
                  : "GitHub job state could not be refreshed.",
                result: {
                  bindingId: command.bindingId,
                  ...(command.type === "job.refresh" ? { jobId: command.jobId } : {}),
                  code: abort.signal.aborted
                    ? "refresh_cancelled"
                    : (githubFailure?.code ?? "job_refresh_failed"),
                  nextStep:
                    githubFailure?.nextStep ??
                    "Check repository access and retry the read; for large queues, refresh a known job ID directly.",
                },
              });
            })
            .finally(() => {
              this.tasks.delete(operation.id);
            });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "runner.run": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          const broker = this.runnerConnection();
          const binding = (await broker.repositories()).find(
            (item) => item.id === command.bindingId,
          );
          if (!binding)
            throw new VectisError("repository_missing", "This repository binding is unavailable.");
          this.store.updateActivity(operation.id, (base) => ({
            ...base,
            bindingId: binding.id,
            environmentId: binding.environmentId,
            repository: { id: binding.repositoryId, name: binding.repositoryName },
          }));
          const environment = snapshot.environments.find(
            (item) => item.id === binding.environmentId,
          );
          if (!environment || environment.state !== "ready")
            throw new VectisError("setup_required", "Prepare this repository's environment first.");
          const abort = new AbortController();
          let startId: string | undefined;
          const demandJobId = command.jobId;
          if (demandJobId === undefined && restrictiveAccess(binding.access))
            throw new VectisError(
              "job_required",
              "Start a specific job under this repository access policy.",
            );
          const done = runRunnerTask(
            command.bindingId,
            operation.id,
            environment,
            {
              broker,
              request: {
                ...(demandJobId === undefined ? {} : { jobId: demandJobId }),
                ...(command.automatic ? { automatic: true } : {}),
              },
              ...(demandJobId === undefined
                ? {}
                : {
                    needed: async (signal) => {
                      if (
                        command.automatic &&
                        !(await broker.repositories()).some(
                          (item) => item.id === command.bindingId && item.automatic,
                        )
                      )
                        return false;
                      const job = await broker.refreshJob(command.bindingId, demandJobId, signal);
                      this.store.updateActivity(operation.id, (base) => ({
                        ...base,
                        subject: {
                          ...base.subject,
                          type: "runner",
                          requestedJob: Schema.decodeUnknownSync(ActivityJob)(job),
                        },
                      }));
                      // GitHub reports runner ID 0 for a queued job that no runner has taken.
                      if (job.status !== "queued" || job.runnerId) return false;
                      if (!matchesRunnerLabels(job.labels, environment.os, environment.id))
                        throw new VectisError(
                          "runner_labels_mismatch",
                          "The GitHub job requires different runner capabilities.",
                        );
                      const current = (await broker.repositories()).find(
                        (item) => item.id === command.bindingId,
                      );
                      if (!current)
                        throw new VectisError(
                          "repository_missing",
                          "This repository binding is unavailable.",
                        );
                      const access = jobAccess(current.access, job);
                      if (access && (access !== "approval_required" || command.automatic))
                        throw new VectisError(
                          access,
                          "This job is refused by the repository access policy.",
                        );
                      return true;
                    },
                  }),
              start: async () => {
                const started = this.submitChild(operation.id, `${operation.id}:start`, {
                  type: "environment.start",
                  id: environment.id,
                });
                startId = started.id;
                const cancelStart = () => {
                  if (this.closing) this.tasks.get(started.id)?.abort.abort();
                  else
                    this.submitChild(operation.id, `${operation.id}:cancel-start`, {
                      type: "operation.cancel",
                      id: started.id,
                    });
                };
                abort.signal.addEventListener("abort", cancelStart, { once: true });
                if (abort.signal.aborted) cancelStart();
                try {
                  await this.waitForOperation(started.id);
                } finally {
                  abort.signal.removeEventListener("abort", cancelStart);
                }
                const instance = this.store
                  .snapshot()
                  .instances.find((item) => item.id === started.id);
                if (!instance || instance.status !== "running")
                  throw new VectisError("runner_vm_missing", "The runner VM did not start.");
                return instance;
              },
              stop: async () => {
                if (!startId) return;
                const current = this.store.snapshot().instances.find((item) => item.id === startId);
                if (!current || current.status === "stopped") return;
                const stopped = this.submitChild(operation.id, `${operation.id}:stop`, {
                  type: "instance.stop",
                  id: startId,
                });
                await this.waitForOperation(stopped.id);
                const instance = this.store
                  .snapshot()
                  .instances.find((item) => item.id === startId);
                if (instance && instance.status !== "stopped")
                  throw new VectisError(
                    "runner_cleanup_required",
                    "Owned VM termination is unconfirmed.",
                  );
              },
              progress: (result) => {
                operation = this.store.update(operation, {
                  result,
                  message: `Runner: ${result.stage}.`,
                });
              },
            },
            abort.signal,
          )
            .then((completed) => {
              this.store.update(operation, {
                status: completed.status,
                message: completed.message,
                result: {
                  ...completed.progress,
                  ...("code" in completed
                    ? {
                        code: completed.code,
                        ...(completed.status === "cancelled"
                          ? {}
                          : {
                              nextStep:
                                "nextStep" in completed
                                  ? completed.nextStep
                                  : completed.status === "action_required"
                                    ? completed.code === "runner_cleanup_required"
                                      ? "Confirm the owned VM is stopped. While connected, Vectis retries GitHub cleanup automatically for up to 30 minutes. Use vectis runner reconcile with this operation ID if cleanup remains unresolved."
                                      : "Inspect the owned instance, then run vectis runner reconcile with this operation ID."
                                    : "Inspect the environment prerequisites and GitHub run before requesting a fresh runner.",
                            }),
                      }
                    : {}),
                },
              });
            })
            .catch(() => {
              this.store.update(operation, {
                status: "action_required",
                message: "Runner recovery requires inspection.",
              });
            })
            .finally(() => {
              this.tasks.delete(operation.id);
            });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "runner.reconcile": {
          result = await this.reconcileRunner(command.id);
          break;
        }
        case "activity.cancel": {
          const activity = snapshot.activities?.find((item) => item.id === command.id);
          if (!activity)
            throw new VectisError(
              "operation_not_cancellable",
              "No cancellable activity has this ID.",
            );
          const members = this.store.activityMembers(activity.id);
          const active = members.filter((member) => this.tasks.has(member.id));
          if (active.length) {
            for (const member of active) this.tasks.get(member.id)?.abort.abort();
            result = {
              activityId: activity.id,
              operationIds: active.map((member) => member.id),
              cancellationRequested: true,
            };
          } else {
            result = {
              activityId: activity.id,
              ...this.closeWaitingOperation(decidingMember(activity, members)),
            };
          }
          break;
        }
        case "operation.cancel": {
          const active = this.tasks.get(command.id);
          if (active) {
            active.abort.abort();
            result = { operationId: command.id, cancellationRequested: true };
            break;
          }
          result = this.closeWaitingOperation(
            snapshot.operations.find((item) => item.id === command.id),
          );
          break;
        }
        case "machine.configure":
          this.store.put("machine", "self", {
            ...snapshot.machine,
            maxRunners: command.maxRunners,
          });
          break;
        case "machine.pause":
          this.store.put("machine", "self", { ...snapshot.machine, paused: command.paused });
          break;
        case "environment.register":
          await this.runtime.validate(command.environment);
          if (
            command.environment.os === "linux" &&
            command.environment.sshUser &&
            command.environment.sshHostKeyMode !== "instance"
          )
            throw new VectisError(
              "setup_required",
              "This Linux image does not install an instance-specific SSH host key.",
              "Prepare a new Linux environment with this version of Vectis.",
            );
          if (
            snapshot.instances.some(
              (instance) =>
                instance.environmentId === command.environment.id && instance.status !== "stopped",
            )
          )
            throw new VectisError(
              "environment_busy",
              "Stop or reconcile this environment's instances before changing it.",
            );
          this.store.put("environment", command.environment.id, command.environment);
          completeMacRegistration(this.store, command.environment);
          break;
        case "environment.configure": {
          const current = snapshot.environments.find((item) => item.id === command.id);
          if (!current) throw new VectisError("environment_missing", "Environment not found.");
          if (
            command.cpu === undefined &&
            command.memoryMiB === undefined &&
            command.storagePath === undefined &&
            command.x64 === undefined &&
            command.egress === undefined
          )
            throw new VectisError(
              "invalid_request",
              "Provide CPU, memory, a storage path, x64 or egress.",
            );
          if (command.x64 === "rosetta" && current.os !== "linux")
            throw new VectisError(
              "unsupported",
              "Rosetta x86_64 support is available only for Linux environments.",
            );
          if (
            snapshot.instances.some(
              (item) =>
                item.environmentId === command.id &&
                item.status === "running" &&
                item.memoryMiB === undefined,
            )
          )
            throw new VectisError(
              "environment_busy",
              "Stop legacy instances before changing their resource configuration.",
            );
          const { x64, ...configuration } = current;
          const enabledX64 = command.x64 === "off" ? undefined : (command.x64 ?? x64);
          const environment = {
            ...configuration,
            ...(enabledX64 ? { x64: enabledX64 } : {}),
            ...(command.egress !== undefined ? { egress: command.egress } : {}),
            ...(command.cpu !== undefined ? { cpu: command.cpu } : {}),
            ...(command.memoryMiB !== undefined ? { memoryMiB: command.memoryMiB } : {}),
            ...(command.storagePath !== undefined ? { storagePath: command.storagePath } : {}),
          };
          await this.runtime.validate(environment);
          this.store.put("environment", command.id, environment);
          result = { environment, appliesTo: "future_instances" };
          break;
        }
        case "environment.remove":
          if (
            snapshot.instances.some(
              (instance) => instance.environmentId === command.id && instance.status !== "stopped",
            )
          )
            throw new VectisError(
              "environment_busy",
              "The environment has running or interrupted instances.",
            );
          this.store.remove("environment", command.id);
          break;
        case "environment.start": {
          if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
          if (
            this.store
              .list("preparation")
              .some((value) => Schema.decodeUnknownSync(Preparation)(value).phase === "booting")
          )
            throw new VectisError(
              "reconciliation_required",
              "A preparation guest needs exit verification before VM admission.",
            );
          if (snapshot.machine.paused)
            throw new VectisError("machine_paused", "The machine is paused.", "Run vectis resume.");
          if (snapshot.instances.some((instance) => instance.status === "interrupted"))
            throw new VectisError(
              "reconciliation_required",
              "An interrupted instance needs inspection before new work can start.",
            );
          const defaults = Schema.decodeUnknownSync(Environment)(
            this.store.get("environment", command.id),
          );
          const environment = {
            ...defaults,
            ...(command.cpu !== undefined ? { cpu: command.cpu } : {}),
            ...(command.memoryMiB !== undefined ? { memoryMiB: command.memoryMiB } : {}),
            ...(command.storagePath !== undefined ? { storagePath: command.storagePath } : {}),
          };
          this.runtime.validateResources(environment);
          const admissionError = instanceAdmissionError(snapshot, environment, {
            cpus: cpus().length,
            memoryBytes: totalmem(),
          });
          if (admissionError) throw admissionError;
          const id = operation.id;
          const record = {
            id,
            environmentId: environment.id,
            directory: this.runtime.directoryFor(id, environment),
            cpu: environment.cpu,
            memoryMiB: environment.memoryMiB,
            status: "starting" as const,
            pid: 0,
            createdAt: operation.createdAt,
          };
          this.store.put("instance", id, record);
          const abort = new AbortController();
          const done = (async () => {
            try {
              const instance = await this.runtime.start(
                id,
                environment,
                (cleaned) => {
                  this.store.put("instance", id, {
                    ...record,
                    status: cleaned ? "stopped" : "interrupted",
                    pid: 0,
                  });
                },
                abort.signal,
              );
              this.store.put("instance", id, {
                ...record,
                status: "running",
                pid: instance.process.pid ?? 0,
                ...(instance.macAddress ? { macAddress: instance.macAddress } : {}),
                ...(instance.sshHost ? { sshHost: instance.sshHost } : {}),
                ...(instance.sshPort ? { sshPort: instance.sshPort } : {}),
                ...(instance.knownHostsPath ? { knownHostsPath: instance.knownHostsPath } : {}),
              });
              this.store.update(operation, {
                status: "succeeded",
                message: "Completed.",
                result: { instanceId: id },
              });
            } catch (error) {
              const remaining =
                error instanceof VectisError && error.code === "storage_access_required"
                  ? false
                  : await this.runtime.hasWorkDirectory(id, record.directory).catch(() => true);
              this.store.put("instance", id, {
                ...record,
                status: remaining ? "interrupted" : "stopped",
              });
              if (abort.signal.aborted)
                this.store.update(operation, {
                  status: remaining ? "action_required" : "cancelled",
                  message: remaining
                    ? "VM startup stopped; its work directory still needs inspection."
                    : "VM startup cancelled and cleaned up.",
                  result: {
                    code: remaining ? "reconciliation_required" : "startup_cancelled",
                    instanceId: id,
                  },
                });
              else this.failOperation(operation, error);
            }
          })().finally(() => {
            this.tasks.delete(operation.id);
          });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "instance.reconcile": {
          if (this.tasks.has(command.id))
            throw new VectisError(
              "instance_starting",
              "The instance startup task has not finished.",
              "Cancel the startup operation and wait for cleanup before reconciling.",
            );
          const instance = snapshot.instances.find((item) => item.id === command.id);
          if (!instance) throw new VectisError("instance_missing", "Instance not found.");
          if (
            instance.status !== "interrupted" ||
            !(await this.runtime.reconcile(command.id, instance.directory))
          )
            throw new VectisError(
              "reconciliation_required",
              "Process exit is not yet verified.",
              "Inspect the instance and retry reconciliation after the runtime has exited.",
            );
          this.store.put("instance", command.id, { ...instance, status: "stopped", pid: 0 });
          break;
        }
        case "instance.stop":
          await this.runtime.stop(command.id);
          break;
        case "migration.preview":
          result = previewMigration(command.source, command.targets);
          break;
      }
      this.store.update(operation, {
        status: "succeeded",
        message: "Completed.",
        ...(result !== undefined ? { result } : {}),
      });
    } catch (error) {
      this.failOperation(operation, error);
    }
  }
  private failOperation(operation: Operation, error: unknown) {
    const issue =
      error instanceof VectisError
        ? error
        : new VectisError("operation_failed", "The operation could not be completed.");
    this.store.update(operation, {
      status: [
        "setup_required",
        "rosetta_not_installed",
        "rosetta_unsupported",
        "rosetta_guest_unprepared",
        "runtime_missing",
        "runtime_incompatible",
        "storage_unavailable",
        "storage_access_required",
        "reconciliation_required",
      ].includes(issue.code)
        ? "action_required"
        : "failed",
      message: issue.message,
      result: { code: issue.code, nextStep: issue.nextStep },
    });
  }
  private async waitForOperation(id: string) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const operation = this.store.snapshot().operations.find((item) => item.id === id);
      if (!operation)
        throw new VectisError("operation_missing", "Runner control operation is missing.");
      if (operation.status === "succeeded") return;
      if (operation.status !== "accepted" && operation.status !== "running") {
        const result = operation.result;
        if (
          typeof result === "object" &&
          result !== null &&
          "code" in result &&
          typeof result.code === "string" &&
          ["rosetta_not_installed", "rosetta_unsupported", "rosetta_guest_unprepared"].includes(
            result.code,
          )
        )
          throw new VectisError(
            result.code,
            operation.message,
            "nextStep" in result && typeof result.nextStep === "string"
              ? result.nextStep
              : undefined,
          );
        throw new VectisError("runner_control_failed", operation.message);
      }
      await delay(100);
    }
    throw new VectisError("runner_control_timeout", "Runner VM control did not finish in time.");
  }
  async drain() {
    await this.queue;
    await this.cleanupSweep;
  }
  beginShutdown(ifIdle: boolean) {
    const snapshot = this.store.snapshot();
    if (
      ifIdle &&
      (snapshot.preparationBusy ||
        snapshot.instances.some((instance) => instance.status !== "stopped") ||
        snapshot.operations.some((operation) =>
          ["accepted", "running"].includes(operation.status),
        ) ||
        this.tasks.size > 0 ||
        this.cleanupSweep !== undefined)
    )
      throw new VectisError(
        "service_busy",
        "The service still has active work or an instance requiring reconciliation.",
        "Pause new jobs, let active work finish, reconcile interrupted instances, then retry.",
      );
    this.closing = true;
  }
  async close() {
    this.closing = true;
    this.stopWatchingJobs();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupAbort.abort();
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.all([this.queue, this.cleanupSweep]);
    await Promise.all([...this.tasks.values()].map((task) => task.done));
    await this.runtime.close();
  }
}
