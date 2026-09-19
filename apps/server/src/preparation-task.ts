import { hasReservedEnvironment } from "./preparation-state.js";
import { Schema } from "effect";
import {
  Preparation,
  LinuxPreparation,
  VectisError,
  type Command,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import {
  prepareLinux,
  preparationDirectory,
  validatePreparation,
} from "../../../packages/runner/src/linux-preparation.js";
import { preparationStopped } from "../../../packages/runner/src/preparation-process.js";
import type { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { Store } from "./store.js";

export async function startPreparation(
  store: Store,
  runtime: VmRuntime,
  operation: Operation,
  command: Extract<Command, { type: "environment.prepare-linux" | "environment.resume" }>,
) {
  const snapshot = store.snapshot();
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
      "Image preparation requires an idle machine with no unresolved runners.",
    );
  if (snapshot.machine.paused)
    throw new VectisError(
      "machine_paused",
      "Resume the machine before preparing a guest.",
      "Run vectis resume, then retry.",
    );
  let preparation: Preparation;
  if (command.type === "environment.resume") {
    preparation = Schema.decodeUnknownSync(Preparation)(store.get("preparation", command.id));
    if (snapshot.environments.some((item) => item.id === preparation.configuration.id))
      throw new VectisError("preparation_complete", "This environment has already been prepared.");
  } else {
    const configuration = Schema.decodeUnknownSync(LinuxPreparation)(command);
    if (
      snapshot.environments.some((item) => item.id === configuration.id) ||
      hasReservedEnvironment(store, configuration.id)
    )
      throw new VectisError(
        "environment_exists",
        "This environment already exists or has a preparation to resume.",
      );
    preparation = { id: operation.id, configuration, phase: "downloading" };
  }
  for (const value of store.list("preparation")) {
    const pending = Schema.decodeUnknownSync(Preparation)(value);
    if (pending.id !== preparation.id && pending.phase === "booting")
      throw new VectisError(
        "reconciliation_required",
        "Another preparation guest needs exit verification.",
      );
  }
  await validatePreparation(preparation.configuration, runtime.options);
  store.put("preparation", preparation.id, preparation);
  const abort = new AbortController();
  const bounded = AbortSignal.any([abort.signal, AbortSignal.timeout(3600000)]);
  const done = prepareLinux(preparation, runtime.options, bounded, (phase, received) => {
    preparation = { ...preparation, phase };
    store.put("preparation", preparation.id, preparation);
    operation = store.update(operation, {
      message: `Guest preparation: ${phase}.`,
      result: {
        setupId: preparation.id,
        directory: preparationDirectory(preparation),
        phase,
        ...(received === undefined ? {} : { receivedBytes: received }),
      },
    });
  })
    .then(async (environment) => {
      await runtime.validate(environment);
      store.put("environment", environment.id, environment);
      for (const previous of store.snapshot().operations) {
        if (
          previous.id !== operation.id &&
          previous.status === "action_required" &&
          ["environment.prepare-linux", "environment.resume"].includes(previous.command) &&
          Schema.is(Schema.Struct({ setupId: Schema.String }))(previous.result) &&
          previous.result.setupId === preparation.id
        )
          store.update(previous, {
            status: "succeeded",
            message: "Preparation completed by a resumed operation.",
            result: { setupId: preparation.id, environment },
          });
      }
      store.update(operation, {
        status: "succeeded",
        message:
          "Ubuntu guest prepared and registered. Connect a repository to run its verification job.",
        result: { setupId: preparation.id, environment },
      });
    })
    .catch(async (error) => {
      if (
        preparation.phase !== "booting" ||
        (await preparationStopped(preparationDirectory(preparation), preparation.id))
      ) {
        preparation = { ...preparation, phase: "interrupted" };
        store.put("preparation", preparation.id, preparation);
      }
      const issue =
        error instanceof VectisError
          ? error
          : bounded.aborted
            ? new VectisError("preparation_cancelled", "Preparation stopped and can be resumed.")
            : error instanceof Error && "code" in error && error.code === "ENOSPC"
              ? new VectisError("insufficient_disk", "The image storage volume ran out of space.")
              : error instanceof Error &&
                  "code" in error &&
                  ["EACCES", "EPERM"].includes(String(error.code))
                ? new VectisError(
                    "storage_unavailable",
                    "The selected image storage is not accessible.",
                  )
                : new VectisError("preparation_interrupted", "Guest preparation did not complete.");
      store.update(operation, {
        status: "action_required",
        message: issue.message,
        result: {
          setupId: preparation.id,
          phase: preparation.phase,
          directory: preparationDirectory(preparation),
          code: issue.code,
          nextStep: `Inspect prerequisites, then resume with environment resume ${preparation.id}. Partial downloads are retained.`,
        },
      });
    });
  return { setupId: preparation.id, abort, done };
}
