import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { availableHostMemory } from "../../../packages/runner/src/memory.js";
import { join } from "node:path";
import { Schema } from "effect";
import {
  MacInstallation,
  Preparation,
  VectisError,
  type Command,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import {
  installMacGuest,
  installedMacBuild,
  validateMacInstallation,
} from "../../../packages/runner/src/macos-installation.js";
import {
  preparationStopped,
  runPreparationProcess,
} from "../../../packages/runner/src/preparation-process.js";
import type { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { Store } from "./store.js";

export const MacInstallationRecord = Schema.Struct({
  id: Schema.String,
  configuration: MacInstallation,
  directory: Schema.String,
  attemptId: Schema.String,
  phase: Schema.Literals(["installing", "setup_running", "setup_required", "interrupted"]),
  bundle: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
});
export async function recoverMacInstallations(store: Store) {
  for (const value of store.list("macInstallation")) {
    const record = Schema.decodeUnknownSync(MacInstallationRecord)(value);
    if (
      record.phase !== "setup_required" &&
      (await preparationStopped(record.directory, record.attemptId))
    ) {
      const bundle = join(record.directory, "base.bundle");
      const build = await installedMacBuild(bundle).catch(() => undefined);
      store.put(
        "macInstallation",
        record.id,
        build
          ? { ...record, phase: "setup_required", bundle, build }
          : { ...record, phase: "interrupted" },
      );
    }
  }
}
export function hasUnconfirmedMacInstallation(store: Store) {
  return store
    .list("macInstallation")
    .some((value) =>
      ["installing", "setup_running"].includes(
        Schema.decodeUnknownSync(MacInstallationRecord)(value).phase,
      ),
    );
}
export async function startMacInstallation(
  store: Store,
  runtime: VmRuntime,
  operation: Operation,
  command: Extract<
    Command,
    {
      type:
        | "environment.install-macos"
        | "environment.resume-macos"
        | "environment.open-macos-setup";
    }
  >,
) {
  await recoverMacInstallations(store);
  const snapshot = store.snapshot();
  if (snapshot.machine.paused)
    throw new VectisError("machine_paused", "Resume this machine before installing macOS.");
  if (
    snapshot.instances.some((item) => item.status !== "stopped") ||
    snapshot.operations.some(
      (item) =>
        item.command === "runner.run" &&
        ["accepted", "running", "action_required"].includes(item.status),
    )
  )
    throw new VectisError(
      "preparation_busy",
      "Installation requires an idle machine with no unresolved runners.",
    );
  if (
    hasUnconfirmedMacInstallation(store) ||
    store
      .list("preparation")
      .some((value) => Schema.decodeUnknownSync(Preparation)(value).phase === "booting")
  )
    throw new VectisError(
      "reconciliation_required",
      "A previous macOS installer needs exit verification.",
    );
  const previous =
    command.type !== "environment.install-macos"
      ? Schema.decodeUnknownSync(MacInstallationRecord)(store.get("macInstallation", command.id))
      : undefined;
  const configuration =
    previous?.configuration ?? Schema.decodeUnknownSync(MacInstallation)(command);
  if (snapshot.environments.some((item) => item.id === configuration.id))
    throw new VectisError("environment_exists", "This environment is already registered.");
  if (
    !previous &&
    store
      .list("macInstallation")
      .some(
        (value) =>
          Schema.decodeUnknownSync(MacInstallationRecord)(value).configuration.id ===
          configuration.id,
      )
  )
    throw new VectisError(
      "installation_exists",
      "Resume the existing installation for this environment identifier.",
    );
  if (command.type === "environment.open-macos-setup") {
    if (!previous || previous.phase !== "setup_required" || !previous.bundle)
      throw new VectisError(
        "setup_required",
        "Finish the macOS restore before opening its setup console.",
      );
    const helper = runtime.options.appleHelper;
    if (!helper)
      throw new VectisError("runtime_missing", "Configure the Apple virtualization helper.");
    await access(helper, constants.X_OK);
    await installedMacBuild(previous.bundle);
    if (configuration.memoryMiB * 1024 ** 2 > (await availableHostMemory()))
      throw new VectisError(
        "insufficient_memory",
        "Not enough available memory to open guest setup.",
      );
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
    const record = { ...previous, phase: "setup_running", attemptId: operation.id };
    store.put("macInstallation", record.id, record);
    const result = {
      setupId: record.id,
      directory: record.directory,
      bundle: record.bundle,
      phase: "setup_running",
      nextStep:
        "In the guest, create a local vectis account without Apple ID, enable Remote Login, and keep guest FileVault disabled for unattended startup. Close the console or cancel this operation to stop the guest.",
    };
    operation = store.update(operation, {
      message: "Opening the macOS guest setup console.",
      result,
    });
    const done = runPreparationProcess(
      {
        helper,
        directory: record.directory,
        id: operation.id,
        args: [
          "run",
          "macos",
          previous.bundle,
          String(configuration.cpu),
          String(configuration.memoryMiB),
          "unused",
          "--console",
        ],
        marker: '"vm.running"',
        markerStream: "stdout",
      },
      signal,
    )
      .then(
        () => "Guest console closed. Verify guest SSH before registering the runner.",
        () => "Guest console stopped or could not start. Guest setup still requires verification.",
      )
      .then((message) => {
        store.put("macInstallation", record.id, { ...record, phase: "setup_required" });
        store.update(operation, {
          status: "action_required",
          message,
          result: {
            ...result,
            phase: "setup_required",
            nextStep:
              "Reopen the console to continue guest setup, or configure and verify guest SSH before runner registration.",
          },
        });
      });
    return { abort, done };
  }
  if (previous?.phase === "setup_required") {
    store.update(operation, {
      status: "action_required",
      message: "macOS is already installed. Complete guest setup before registering it.",
      result: { ...previous, setupId: previous.id },
    });
    return { abort: new AbortController(), done: Promise.resolve() };
  }
  await validateMacInstallation(configuration, runtime.options.appleHelper);
  const helper = runtime.options.appleHelper;
  if (!helper)
    throw new VectisError("runtime_missing", "Configure the Apple virtualization helper.");
  const directory = join(
    configuration.imageDirectory,
    `vectis-${configuration.id}-${operation.id}`,
  );
  const record: typeof MacInstallationRecord.Type = {
    id: previous?.id ?? operation.id,
    attemptId: operation.id,
    configuration,
    directory,
    phase: "installing",
  };
  store.put("macInstallation", record.id, record);
  operation = store.update(operation, {
    result: { setupId: record.id, directory, phase: "installing" },
    message: "Installing macOS from the selected Apple restore image.",
  });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
  const done = installMacGuest(configuration, helper, directory, operation.id, signal)
    .then(({ bundle, build }) => {
      store.put("macInstallation", record.id, {
        ...record,
        phase: "setup_required",
        bundle,
        build,
      });
      store.update(operation, {
        status: "action_required",
        message: "macOS installed. Guest Setup Assistant is still required.",
        result: {
          setupId: record.id,
          directory,
          bundle,
          build,
          phase: "setup_required",
          code: "guest_setup_required",
          nextStep:
            "Complete the guest Setup Assistant and configure guest-only SSH before registering this bundle as a ready runner. No runner has been registered.",
        },
      });
    })
    .catch(() => {
      store.put("macInstallation", record.id, { ...record, phase: "interrupted" });
      store.update(operation, {
        status: "action_required",
        message: signal.aborted
          ? "macOS installation stopped."
          : "macOS installation did not complete.",
        result: {
          setupId: record.id,
          directory,
          phase: "interrupted",
          code: "macos_installation_interrupted",
          nextStep: `Inspect the private preparation log, then use environment resume-macos ${record.id}. Retried installs use a new bundle and retain interrupted files for inspection.`,
        },
      });
    });
  return { abort, done };
}
