import { createHash, randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { Schema } from "effect";
import {
  Command,
  Environment,
  VectisError,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import { previewMigration } from "../../../packages/migration/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Store } from "./store.js";

export class Service {
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(
    readonly store: Store,
    readonly runtime: VmRuntime,
  ) {
    store.recover();
  }
  async initialize() {
    for (const instance of this.store.snapshot().instances) {
      if (
        instance.status === "interrupted" &&
        (await this.runtime.reconcile(instance.id, instance.directory))
      )
        this.store.put("instance", instance.id, { ...instance, status: "stopped", pid: 0 });
    }
  }
  submit(key: string, command: Command): Operation {
    if (this.closing) throw new VectisError("service_stopping", "The service is stopping.");
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
      switch (command.type) {
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
          const id = randomUUID();
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
  async drain() {
    await this.queue;
  }
  async close() {
    this.closing = true;
    await this.queue;
    await this.runtime.close();
  }
}
