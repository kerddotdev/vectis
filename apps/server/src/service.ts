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
import type { JobRefresh, JobScan } from "../../../packages/protocol/src/jobs.js";
import { RunnerProgress, type RunnerBroker } from "../../../packages/protocol/src/runners.js";
import type {
  MachineRepositories,
  RepositoryConnection,
} from "../../../packages/protocol/src/repositories.js";
import { runRunnerTask } from "./runner-task.js";
import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { Schema } from "effect";
import {
  Command,
  Environment,
  Preparation,
  VectisError,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import { previewMigration } from "../../../packages/migration/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Store } from "./store.js";

export class Service {
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private preparing: string | undefined;
  private tasks = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(
    readonly store: Store,
    readonly runtime: VmRuntime,
    readonly runnerConnection: () => RunnerBroker & {
      analyzeMigration(bindingId: string, signal: AbortSignal): Promise<MigrationAnalysis>;
      publishMigration(previewId: string, signal: AbortSignal): Promise<MigrationPublication>;
      repositories(): Promise<MachineRepositories>;
      connectRepository(input: RepositoryConnection, signal: AbortSignal): Promise<string>;
      setAutomatic(bindingId: string, enabled: boolean): Promise<void>;
      scanJobs(bindingId: string, signal: AbortSignal): Promise<JobScan>;
      refreshJob(bindingId: string, jobId: number, signal: AbortSignal): Promise<JobRefresh>;
    } = () => {
      throw new VectisError("cloud_unconfigured", "Connect this machine before starting runners.");
    },
  ) {
    store.recover();
  }
  async initialize() {
    await recoverMacInstallations(this.store);
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
  }
  submit(key: string, command: Command): Operation {
    if (this.closing && command.type !== "instance.stop")
      throw new VectisError("service_stopping", "The service is stopping.");
    if (key.length > 200) throw new VectisError("invalid_request", "The request key is too long.");
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const accepted = this.store.accept(key, fingerprint, command.type);
    if (accepted.fresh)
      this.queue = this.queue.then(() => this.execute(accepted.operation, command));
    return accepted.operation;
  }
  private async execute(operation: Operation, command: Command) {
    operation = this.store.update(operation, { status: "running", message: "Running." });
    try {
      let result: unknown;
      const snapshot = this.store.snapshot();
      if (
        (this.preparing || hasUnconfirmedMacInstallation(this.store)) &&
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
        case "environment.install-macos":
        case "environment.resume-macos":
        case "environment.open-macos-setup": {
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
          if (hasUnconfirmedMacInstallation(this.store))
            throw new VectisError(
              "reconciliation_required",
              "A macOS installer needs exit verification.",
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
              "setup_required",
              "Prepare the local environment before connecting a repository.",
            );
          const broker = this.runnerConnection();
          const abort = new AbortController();
          const done = broker
            .connectRepository(
              {
                accountId: command.accountId,
                repositoryName: command.repositoryName,
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
            .catch(() => {
              this.store.update(operation, {
                status: "action_required",
                message: "Repository connection could not be confirmed.",
                result: {
                  code: "repository_connection_unconfirmed",
                  nextStep:
                    "List repository connections before retrying; then check the account, environment and GitHub App access.",
                },
              });
            })
            .finally(() => {
              this.tasks.delete(operation.id);
            });
          this.tasks.set(operation.id, { abort, done });
          return;
        }
        case "repository.automatic": {
          await this.runnerConnection().setAutomatic(command.bindingId, command.enabled);
          result = { bindingId: command.bindingId, automatic: command.enabled };
          break;
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
            .catch(() => {
              this.store.update(operation, {
                status: abort.signal.aborted ? "cancelled" : "failed",
                message: abort.signal.aborted
                  ? "Stopped waiting for GitHub job refresh."
                  : "GitHub job state could not be refreshed.",
                result: {
                  bindingId: command.bindingId,
                  ...(command.type === "job.refresh" ? { jobId: command.jobId } : {}),
                  code: abort.signal.aborted ? "refresh_cancelled" : "job_refresh_failed",
                  nextStep:
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
          const environment = snapshot.environments.find(
            (item) => item.id === binding.environmentId,
          );
          if (!environment || environment.state !== "ready")
            throw new VectisError("setup_required", "Prepare this repository's environment first.");
          const abort = new AbortController();
          let startId: string | undefined;
          const demandJobId = command.jobId;
          const done = runRunnerTask(
            command.bindingId,
            operation.id,
            environment,
            {
              broker,
              ...(demandJobId === undefined
                ? {}
                : {
                    needed: async () => {
                      if (
                        command.automatic &&
                        !(await broker.repositories()).some(
                          (item) => item.id === command.bindingId && item.automatic,
                        )
                      )
                        return false;
                      const job = await broker.refreshJob(
                        command.bindingId,
                        demandJobId,
                        abort.signal,
                      );
                      if (job.status !== "queued") return false;
                      if (!matchesRunnerLabels(job.labels, environment.os, environment.id))
                        throw new VectisError(
                          "runner_labels_mismatch",
                          "The GitHub job requires different runner capabilities.",
                        );
                      return true;
                    },
                  }),
              start: async () => {
                const started = this.submit(`${operation.id}:start`, {
                  type: "environment.start",
                  id: environment.id,
                });
                startId = started.id;
                await this.waitForOperation(started.id);
                const instance = this.store
                  .snapshot()
                  .instances.find((item) => item.id === started.id);
                if (!instance || instance.status !== "running")
                  throw new VectisError("runner_vm_missing", "The runner VM did not start.");
                return instance;
              },
              stop: async () => {
                if (!startId) return;
                const stopped = this.submit(`${operation.id}:stop`, {
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
                        nextStep:
                          completed.status === "action_required"
                            ? "Inspect the owned instance, then run vectis runner reconcile with this operation ID."
                            : "Inspect the environment prerequisites and GitHub run before requesting a fresh runner.",
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
          const interrupted = snapshot.operations.find((item) => item.id === command.id);
          if (
            !interrupted ||
            interrupted.command !== "runner.run" ||
            interrupted.status !== "action_required" ||
            this.tasks.has(command.id)
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
          const broker = this.runnerConnection();
          const lease = await broker.findRunner(progress.leaseKey, AbortSignal.timeout(10000));
          if (!lease)
            throw new VectisError(
              "reconciliation_required",
              "The registration request has no confirmed cloud lease.",
              "Inspect the cloud connection and retry reconciliation; do not start a duplicate runner.",
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
          await broker.releaseRunner(lease.id, AbortSignal.timeout(60000));
          this.store.update(interrupted, {
            status: "cancelled",
            message: "Interrupted runner cleaned up. Check GitHub for the job result.",
            result: { ...progress, leaseId: lease.id, stage: "finished" },
          });
          result = { operationId: interrupted.id, leaseId: lease.id };
          break;
        }
        case "operation.cancel": {
          const active = this.tasks.get(command.id);
          if (!active)
            throw new VectisError(
              "operation_not_cancellable",
              "No active cancellable task has this operation ID.",
            );
          active.abort.abort();
          result = { operationId: command.id, cancellationRequested: true };
          break;
        }
        case "machine.pause":
          this.store.put("machine", "self", { ...snapshot.machine, paused: command.paused });
          break;
        case "environment.register":
          await this.runtime.validate(command.environment);
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
            command.storagePath === undefined
          )
            throw new VectisError("invalid_request", "Provide CPU, memory or a storage path.");
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
          const environment = {
            ...current,
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
          await this.runtime.validate(environment);
          const active = snapshot.instances.filter((instance) => instance.status === "running");
          const memory = active.reduce(
            (sum, instance) =>
              sum +
              (instance.memoryMiB ??
                snapshot.environments.find((item) => item.id === instance.environmentId)
                  ?.memoryMiB ??
                0),
            environment.memoryMiB,
          );
          const cpu = active.reduce(
            (sum, instance) =>
              sum +
              (instance.cpu ??
                snapshot.environments.find((item) => item.id === instance.environmentId)?.cpu ??
                0),
            environment.cpu,
          );
          if (cpu > cpus().length)
            throw new VectisError("capacity_exceeded", "Requested VM CPUs exceed the host budget.");
          if (memory * 1024 * 1024 > totalmem() * 0.75)
            throw new VectisError(
              "capacity_exceeded",
              "Requested VM memory exceeds the host budget.",
            );
          if (
            environment.os === "macos" &&
            active.filter(
              (instance) =>
                snapshot.environments.find((item) => item.id === instance.environmentId)?.os ===
                "macos",
            ).length >= 2
          )
            throw new VectisError("macos_limit", "The two-instance macOS limit has been reached.");
          const id = operation.id;
          const record = {
            id,
            environmentId: environment.id,
            directory: this.runtime.directoryFor(id, environment),
            cpu: environment.cpu,
            memoryMiB: environment.memoryMiB,
            status: "interrupted" as const,
            pid: 0,
            createdAt: operation.createdAt,
          };
          this.store.put("instance", id, record);
          try {
            const instance = await this.runtime.start(id, environment, (cleaned) => {
              this.store.put("instance", id, {
                ...record,
                status: cleaned ? "stopped" : "interrupted",
                pid: 0,
              });
            });
            this.store.put("instance", id, {
              ...record,
              status: "running",
              pid: instance.process.pid ?? 0,
              ...(instance.macAddress ? { macAddress: instance.macAddress } : {}),
              ...(instance.sshHost ? { sshHost: instance.sshHost } : {}),
              ...(instance.sshPort ? { sshPort: instance.sshPort } : {}),
            });
          } catch (error) {
            const remaining = await this.runtime.hasWorkDirectory(id, record.directory);
            this.store.put("instance", id, {
              ...record,
              status: remaining ? "interrupted" : "stopped",
            });
            throw error;
          }
          result = { instanceId: id };
          break;
        }
        case "instance.reconcile": {
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
      const issue =
        error instanceof VectisError
          ? error
          : new VectisError("operation_failed", "The operation could not be completed.");
      this.store.update(operation, {
        status: [
          "setup_required",
          "runtime_missing",
          "runtime_incompatible",
          "storage_unavailable",
          "reconciliation_required",
        ].includes(issue.code)
          ? "action_required"
          : "failed",
        message: issue.message,
        result: { code: issue.code, nextStep: issue.nextStep },
      });
    }
  }
  private async waitForOperation(id: string) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const operation = this.store.snapshot().operations.find((item) => item.id === id);
      if (!operation)
        throw new VectisError("operation_missing", "Runner control operation is missing.");
      if (operation.status === "succeeded") return;
      if (operation.status !== "accepted" && operation.status !== "running")
        throw new VectisError("runner_control_failed", operation.message);
      await delay(100);
    }
    throw new VectisError("runner_control_timeout", "Runner VM control did not finish in time.");
  }
  async drain() {
    await this.queue;
  }
  async close() {
    this.closing = true;
    for (const task of this.tasks.values()) task.abort.abort();
    await this.queue;
    await Promise.all([...this.tasks.values()].map((task) => task.done));
    await this.runtime.close();
  }
}
