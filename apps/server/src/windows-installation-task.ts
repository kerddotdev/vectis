import { hasReservedEnvironment } from "./preparation-state.js";
import { join } from "node:path";
import { Schema } from "effect";
import {
  WindowsInstallation,
  VectisError,
  type Command,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import {
  installWindowsGuest,
  validateWindowsInstallation,
} from "../../../packages/runner/src/windows-installation.js";
import { preparationStopped } from "../../../packages/runner/src/preparation-process.js";
import type { SetupCredentials } from "../../../packages/runner/src/windows-media.js";
import type { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { Store } from "./store.js";

export const WindowsInstallationRecord = Schema.Struct({
  id: Schema.String,
  attemptId: Schema.String,
  configuration: WindowsInstallation,
  directory: Schema.String,
  phase: Schema.Literals(["provisioning", "booting", "prepared", "interrupted"]),
});
type WindowsInstallationRecord = typeof WindowsInstallationRecord.Type;

export async function recoverWindowsInstallations(store: Store) {
  for (const value of store.list("windowsInstallation")) {
    const record = Schema.decodeUnknownSync(WindowsInstallationRecord)(value);
    if (
      record.phase === "booting" &&
      (await preparationStopped(record.directory, record.attemptId))
    )
      store.put("windowsInstallation", record.id, { ...record, phase: "interrupted" });
  }
}
export function hasUnconfirmedWindowsInstallation(store: Store) {
  return store
    .list("windowsInstallation")
    .some(
      (value) => Schema.decodeUnknownSync(WindowsInstallationRecord)(value).phase === "booting",
    );
}
export async function startWindowsInstallation(
  store: Store,
  runtime: VmRuntime,
  operation: Operation,
  command: Extract<Command, { type: "environment.install-windows" | "environment.resume-windows" }>,
  credentials?: SetupCredentials,
) {
  if (!credentials)
    throw new VectisError(
      "credential_store_unavailable",
      "Configure the Vectis Keychain helper before installing Windows.",
    );
  await recoverWindowsInstallations(store);
  const snapshot = store.snapshot();
  if (snapshot.machine.paused)
    throw new VectisError("machine_paused", "Resume the machine before installing Windows.");
  if (
    snapshot.preparationBusy ||
    snapshot.instances.some((item) => item.status !== "stopped") ||
    snapshot.operations.some(
      (item) =>
        item.command === "runner.run" &&
        ["accepted", "running", "action_required"].includes(item.status),
    )
  )
    throw new VectisError(
      "preparation_busy",
      "Windows installation requires an idle host with confirmed VM exits.",
    );
  let record: WindowsInstallationRecord;
  if (command.type === "environment.resume-windows") {
    record = Schema.decodeUnknownSync(WindowsInstallationRecord)(
      store.get("windowsInstallation", command.id),
    );
    if (snapshot.environments.some((item) => item.id === record.configuration.id))
      throw new VectisError("environment_exists", "This environment is already registered.");
    record = { ...record, attemptId: operation.id, phase: "provisioning" };
  } else {
    const configuration = Schema.decodeUnknownSync(WindowsInstallation)(command);
    if (
      snapshot.environments.some((item) => item.id === configuration.id) ||
      hasReservedEnvironment(store, configuration.id)
    )
      throw new VectisError(
        "environment_exists",
        "This environment already exists or has a setup to resume.",
      );
    record = {
      id: operation.id,
      attemptId: operation.id,
      configuration,
      directory: join(configuration.imageDirectory, `vectis-${configuration.id}-${operation.id}`),
      phase: "provisioning",
    };
  }
  await validateWindowsInstallation(record.configuration, runtime.options, record.directory);
  store.put("windowsInstallation", record.id, record);
  operation = store.update(operation, {
    message: "Preparing private Windows installation media.",
    result: { setupId: record.id, directory: record.directory, phase: record.phase },
  });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
  const done = installWindowsGuest(
    record.configuration,
    record.directory,
    record.id,
    operation.id,
    runtime.options,
    credentials,
    signal,
    () => {
      record = { ...record, phase: "booting" };
      store.put("windowsInstallation", record.id, record);
      operation = store.update(operation, {
        message: "Installing Windows in the owned guest.",
        result: { setupId: record.id, directory: record.directory, phase: record.phase },
      });
    },
  )
    .then(async (environment) => {
      await runtime.validate(environment);
      store.put("environment", environment.id, environment);
      store.put("windowsInstallation", record.id, { ...record, phase: "prepared" });
      for (const previous of store.snapshot().operations)
        if (
          previous.status === "action_required" &&
          ["environment.install-windows", "environment.resume-windows"].includes(
            previous.command,
          ) &&
          Schema.is(Schema.Struct({ setupId: Schema.String }))(previous.result) &&
          previous.result.setupId === record.id
        )
          store.update(previous, {
            status: "succeeded",
            message: "Windows setup completed by a resumed operation.",
            result: { setupId: record.id, environment },
          });
      store.update(operation, {
        status: "succeeded",
        message:
          "Windows guest prepared, verified and registered. Connect a repository for its Actions verification job.",
        result: { setupId: record.id, environment },
      });
    })
    .catch(async (error) => {
      if (
        record.phase !== "booting" ||
        (await preparationStopped(record.directory, record.attemptId))
      ) {
        record = { ...record, phase: "interrupted" };
        store.put("windowsInstallation", record.id, record);
      }
      const issue =
        error instanceof VectisError
          ? error
          : new VectisError(
              "windows_setup_interrupted",
              "Windows setup stopped before completion could be confirmed.",
            );
      store.update(operation, {
        status: "action_required",
        message: issue.message,
        result: {
          setupId: record.id,
          phase: record.phase,
          directory: record.directory,
          code: issue.code,
          nextStep: `Inspect the private setup screenshot and preparation log, then use environment resume-windows ${record.id}.`,
        },
      });
    });
  return { abort, done };
}
