import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { cpus, totalmem } from "node:os";
import { Schema } from "effect";
import { VectisError, type Command, type Operation } from "../../../packages/protocol/src/index.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { guestCommandDiagnostics } from "../../../packages/runner/src/guest-diagnostics.js";
import { cloneProvisionImage } from "../../../packages/runner/src/provision-image.js";
import {
  provisionScript,
  provisionLinuxIdentityResetScript,
  provisionShutdownScript,
  setupUploadScripts,
} from "../../../packages/runner/src/provision-scripts.js";
import { runnerVersion } from "../../../packages/runner/src/runner-release.js";
import type { VmRuntime, OwnedInstance } from "../../../packages/runner/src/runtime.js";
import { hasReservedEnvironment } from "./preparation-state.js";
import { instanceAdmissionError } from "./runner-capacity.js";
import type { Store } from "./store.js";

const ProvisionRecord = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  directory: Schema.String,
});
type ProvisionRecord = typeof ProvisionRecord.Type;
const ownerFile = ".vectis-provision.json";
const GuestFailure = Schema.Struct({
  diagnostics: Schema.String.check(Schema.isMaxLength(16384)),
  exitCode: Schema.optional(Schema.Int),
});

async function removeOutput(record: ProvisionRecord) {
  const directory = await lstat(record.directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return;
  if (
    !directory.isDirectory() ||
    (await readFile(join(record.directory, ownerFile), "utf8")) !== JSON.stringify(record)
  )
    throw new VectisError(
      "provision_cleanup_required",
      "Cannot verify ownership of the partial provision directory.",
    );
  await rm(record.directory, { recursive: true, force: true, maxRetries: 3 });
}

export async function recoverProvisions(store: Store) {
  for (const value of store.list("provision")) {
    const record = Schema.decodeUnknownSync(ProvisionRecord)(value);
    const operation = store.snapshot().operations.find((item) => item.id === record.id);
    if (!operation) continue;
    const guestFailure = Schema.is(GuestFailure)(operation.result)
      ? {
          diagnostics: operation.result.diagnostics,
          ...(operation.result.exitCode !== undefined
            ? { exitCode: operation.result.exitCode }
            : {}),
        }
      : undefined;
    const registered = store
      .snapshot()
      .environments.find(
        (item) => item.id === record.environmentId && item.image?.revision === record.id,
      );
    if (registered) {
      store.update(operation, {
        status: "succeeded",
        message: "Provisioned environment registration recovered.",
        result: { stage: "finished", environment: registered },
      });
      store.remove("provision", record.id);
      continue;
    }
    const instance = store.snapshot().instances.find((item) => item.id === record.id);
    if (instance && instance.status !== "stopped") continue;
    try {
      await removeOutput(record);
      store.remove("provision", record.id);
      store.update(operation, {
        status: "failed",
        message: "Interrupted provisioning was cleaned up. Retry with a new operation key.",
        result: { stage: "cleaned", code: "provision_interrupted", ...guestFailure },
      });
    } catch {
      store.update(operation, {
        status: "action_required",
        message: "Provisioning cleanup needs inspection of its owned output.",
        result: {
          stage: "cleaning",
          directory: record.directory,
          code: "provision_cleanup_required",
          ...guestFailure,
        },
      });
    }
  }
}

async function waitForShutdown(instance: OwnedInstance, signal: AbortSignal, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new VectisError(
              "guest_shutdown_timeout",
              "The guest did not shut down cleanly before the timeout.",
            ),
          ),
        timeoutMs,
      );
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      instance.settled.then(resolve, reject);
      if (signal.aborted) cancel();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

export async function startProvision(
  store: Store,
  runtime: VmRuntime,
  operation: Operation,
  command: Extract<Command, { type: "environment.provision" }>,
  options: { shutdownTimeoutMs?: number } = {},
) {
  const snapshot = store.snapshot();
  if (
    snapshot.preparationBusy ||
    store.list("provision").length ||
    snapshot.instances.some((item) => item.status !== "stopped") ||
    snapshot.operations.some(
      (item) =>
        item.command === "runner.run" &&
        ["accepted", "running", "action_required"].includes(item.status),
    )
  )
    throw new VectisError(
      "preparation_busy",
      "Provisioning requires an idle machine with no unresolved preparations or runners.",
    );
  if (snapshot.machine.paused)
    throw new VectisError("machine_paused", "Resume the machine before provisioning a guest.");
  const parent = snapshot.environments.find((item) => item.id === command.from);
  if (!parent)
    throw new VectisError("environment_missing", "The parent environment was not found.");
  if (parent.state !== "ready")
    throw new VectisError("setup_required", "The parent environment must be ready.");
  if (
    snapshot.environments.some((item) => item.id === command.id) ||
    hasReservedEnvironment(store, command.id)
  )
    throw new VectisError(
      "environment_exists",
      "This environment already exists or has a preparation to resume.",
    );
  if (command.setupScript !== undefined && Buffer.byteLength(command.setupScript, "utf8") > 65536)
    throw new VectisError("guest_script_too_large", "Setup scripts cannot exceed 64 KiB UTF-8.");
  if (!isAbsolute(command.imageDirectory))
    throw new VectisError(
      "invalid_path",
      "The provision image directory must be an absolute host path.",
    );
  const directory = join(
    await realpath(dirname(command.imageDirectory)),
    basename(command.imageDirectory),
  );
  for (const environment of snapshot.environments.filter((item) => item.os === "macos")) {
    const bundle = await realpath(environment.basePath).catch(() => undefined);
    if (!bundle) continue;
    const inside = relative(bundle, directory);
    if (!inside || (!inside.startsWith("../") && !isAbsolute(inside)))
      throw new VectisError(
        "invalid_path",
        "Provision output must be outside registered macOS bundles.",
      );
  }
  if (
    await lstat(directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    })
  )
    throw new VectisError(
      "image_directory_exists",
      "Provisioning requires a new image directory; existing paths are preserved.",
    );
  await access(dirname(directory), constants.W_OK | constants.X_OK);
  await runtime.validate(parent);
  const admission = instanceAdmissionError(snapshot, parent, {
    cpus: cpus().length,
    memoryBytes: totalmem(),
  });
  if (admission) throw admission;
  const record = { id: operation.id, environmentId: command.id, directory };
  store.put("provision", operation.id, record);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
  let created = false;
  let instance: OwnedInstance | undefined;
  let stage = "cloning";
  let guestFailure: typeof GuestFailure.Type | undefined;
  const progress = (value: string) => {
    stage = value;
    operation = store.update(operation, {
      message: `Environment provisioning: ${stage}.`,
      result: {
        stage,
        environmentId: command.id,
        parentId: parent.id,
        directory,
        instanceId: operation.id,
        ...guestFailure,
      },
    });
  };
  const done = (async () => {
    signal.throwIfAborted();
    progress("cloning");
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await writeFile(join(directory, ownerFile), JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    let environment = await cloneProvisionImage(
      parent,
      command.id,
      directory,
      runtime.options,
      signal,
    );
    environment = { ...environment, name: command.name ?? command.id };
    progress("booting");
    const instanceRecord = {
      id: operation.id,
      environmentId: environment.id,
      directory: runtime.directoryFor(operation.id, environment),
      cpu: environment.cpu,
      memoryMiB: environment.memoryMiB,
      status: "starting" as const,
      pid: 0,
      createdAt: operation.createdAt,
    };
    store.put("instance", operation.id, instanceRecord);
    instance = await runtime.start(
      operation.id,
      environment,
      (cleaned) => {
        const current =
          store.snapshot().instances.find((item) => item.id === operation.id) ?? instanceRecord;
        store.put("instance", operation.id, {
          ...current,
          status: cleaned ? "stopped" : "interrupted",
        });
      },
      signal,
      { diskInPlace: true },
    );
    const running = {
      ...instanceRecord,
      status: "running" as const,
      pid: instance.process.pid ?? 0,
      ...(instance.macAddress ? { macAddress: instance.macAddress } : {}),
      ...(instance.sshHost ? { sshHost: instance.sshHost } : {}),
      ...(instance.sshPort ? { sshPort: instance.sshPort } : {}),
      ...(instance.knownHostsPath ? { knownHostsPath: instance.knownHostsPath } : {}),
    };
    store.put("instance", operation.id, running);
    progress("waiting_for_guest");
    const connection = await readyGuest(environment, running, signal);
    const shell = environment.os === "windows" ? "powershell" : "bash";
    const runGuest = async (script: string, guestSignal = signal) => {
      try {
        const result = await executeGuest(connection, script, { shell, signal: guestSignal });
        if (result.exitCode !== 0)
          guestFailure = {
            exitCode: result.exitCode,
            diagnostics: guestCommandDiagnostics(result),
          };
        return result;
      } catch (error) {
        if (error instanceof GuestUnavailableError)
          guestFailure = {
            diagnostics: guestCommandDiagnostics({ stderr: error.detail, stdout: "" }),
          };
        throw error;
      }
    };
    if (environment.os === "linux") {
      progress("checking_guest_sudo");
      if ((await runGuest("sudo -n true")).exitCode !== 0)
        throw new VectisError(
          "provision_requires_guest_sudo",
          "Linux provisioning requires passwordless sudo to reset the derived image's machine identity.",
          "Prepare a new Linux environment with this Vectis version, then provision from it.",
        );
    }
    progress("provisioning");
    const scripts = [
      ...(command.setupScript !== undefined
        ? setupUploadScripts(environment.os, command.setupScript)
        : []),
      provisionScript(environment.os, {
        runner: command.runner !== false,
        setup: command.setupScript !== undefined,
      }),
    ];
    for (const script of scripts) {
      const result = await runGuest(script);
      if (result.exitCode !== 0)
        throw new VectisError(
          "provision_script_failed",
          "The guest provisioning script failed. No environment was registered.",
        );
    }
    if (environment.os === "linux") {
      progress("clearing_identity");
      if ((await runGuest(provisionLinuxIdentityResetScript())).exitCode !== 0)
        throw new VectisError(
          "provision_identity_reset_failed",
          "Linux identity cleanup failed. No environment was registered.",
        );
    }
    progress("shutting_down");
    if (!(await runtime.requestShutdown(instance.id))) {
      try {
        const shutdown = await runGuest(
          provisionShutdownScript(environment.os),
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        );
        if (shutdown.exitCode !== 0)
          throw new VectisError(
            "guest_shutdown_failed",
            "Guest shutdown failed. Inspect the guest command diagnostics and passwordless sudo permissions.",
          );
      } catch (error) {
        if (!(error instanceof GuestUnavailableError)) throw error;
      }
    }
    await waitForShutdown(instance, signal, options.shutdownTimeoutMs ?? 120000);
    if (instance.process.exitCode !== 0 || instance.process.signalCode !== null)
      throw new VectisError(
        "guest_shutdown_failed",
        "The provisioning VM did not exit successfully.",
      );
    instance = undefined;
    progress("freezing");
    environment = {
      ...environment,
      image: {
        parentId: parent.id,
        revision: operation.id,
        provisionedAt: new Date().toISOString(),
        ...(command.runner !== false ? { runnerVersion } : {}),
      },
    };
    await runtime.validate(environment);
    await writeFile(join(directory, "image.json"), JSON.stringify(environment.image), {
      flag: "wx",
      mode: 0o600,
    });
    signal.throwIfAborted();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.put("environment", environment.id, environment);
      store.remove("provision", operation.id);
      store.update(operation, {
        status: "succeeded",
        message: "Derived environment provisioned and registered. The parent image was preserved.",
        result: { stage: "finished", environment },
      });
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  })().catch(async (error: unknown) => {
    progress("cleaning");
    try {
      if (instance) {
        if (instance.process.exitCode === null && instance.process.signalCode === null)
          await runtime.stop(instance.id);
        else await instance.settled;
      }
      const current = store.snapshot().instances.find((item) => item.id === operation.id);
      if (current && current.status !== "stopped") {
        if (await runtime.hasWorkDirectory(operation.id, current.directory)) {
          store.put("instance", current.id, { ...current, status: "interrupted" });
          throw new VectisError(
            "provision_cleanup_required",
            "Provisioning VM cleanup is unconfirmed.",
          );
        }
        store.put("instance", current.id, { ...current, status: "stopped", pid: 0 });
      }
      if (created) await removeOutput(record);
      store.remove("provision", operation.id);
      store.update(operation, {
        status: signal.aborted ? "cancelled" : "failed",
        message: signal.aborted
          ? "Provisioning cancelled and owned output removed."
          : error instanceof VectisError
            ? error.message
            : "Environment provisioning failed and owned output was removed.",
        result: {
          stage: "cleaned",
          ...guestFailure,
          code: signal.aborted
            ? "provision_cancelled"
            : error instanceof VectisError
              ? error.code
              : "provision_failed",
          ...(error instanceof VectisError && error.nextStep ? { nextStep: error.nextStep } : {}),
        },
      });
    } catch {
      store.update(operation, {
        status: "action_required",
        message: "Provisioning stopped, but VM exit or output cleanup needs verification.",
        result: {
          stage,
          ...guestFailure,
          directory,
          instanceId: operation.id,
          code: "provision_cleanup_required",
          nextStep:
            "Reconcile the interrupted instance, then restart the service to retry owned output cleanup.",
        },
      });
    }
  });
  return { abort, done };
}
