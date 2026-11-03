import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { bootAutomaticMac } from "../../../packages/runner/src/macos-automatic-boot.js";
import {
  enrollAutomaticMac,
  macCommandLineTools,
  macSetupPassword,
  waitForMacSsh,
} from "../../../packages/runner/src/macos-automatic.js";
import { prepareMacAccess } from "../../../packages/runner/src/macos-access.js";
import { waitForGuestAddress } from "../../../packages/runner/src/guest-address.js";
import { executeGuest } from "../../../packages/runner/src/guest.js";
import { VectisError, type Operation } from "../../../packages/protocol/src/index.js";
import type { VmRuntime } from "../../../packages/runner/src/runtime.js";
import {
  completedMacEnvironment,
  macSetupVerification,
  verifyMacSetupOutput,
} from "./macos-access-task.js";
import { MacInstallationRecord } from "./macos-installation-task.js";
import { completeMacRegistration } from "./macos-registration.js";
import type { Store } from "./store.js";

export async function automateMacSetup(
  store: Store,
  runtime: VmRuntime,
  operation: Operation,
  record: typeof MacInstallationRecord.Type,
  helper: string,
  bundle: string,
  signal: AbortSignal,
) {
  const progress = (step: string, message: string) => {
    operation = store.update(operation, {
      message,
      result: { setupId: record.id, bundle, phase: "setup_running", setupMode: "automatic", step },
    });
  };
  let password = macSetupPassword();
  store.put("macInstallation", record.id, { ...record, bundle, phase: "setup_running" });
  progress("macos.provisioning", "Starting automatic macOS first-boot provisioning.");
  const boot = bootAutomaticMac(
    helper,
    bundle,
    record.directory,
    record.attemptId,
    record.configuration.cpu,
    record.configuration.memoryMiB,
    password,
    signal,
  );
  try {
    const macAddress = await boot.running;
    store.put("macInstallation", record.id, {
      ...record,
      bundle,
      phase: "setup_running",
      macAddress,
    });
    progress("macos.waiting_ssh", "Waiting for the provisioned guest's Remote Login.");
    const readiness = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
    const host = await waitForGuestAddress(macAddress, readiness);
    await waitForMacSsh(host, readiness);
    const { connection } = await prepareMacAccess(
      record.directory,
      record.configuration.id,
      host,
      readiness,
    );
    progress("macos.enrolling", "Enrolling dedicated guest SSH access and passwordless sudo.");
    await enrollAutomaticMac(
      connection,
      password,
      AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    );
    password = "";
    progress("macos.installing_clt", "Installing Apple Command Line Tools (up to 30 minutes).");
    const tools = await executeGuest(connection, macCommandLineTools, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1800000)]),
    });
    if (tools.exitCode !== 0)
      throw new VectisError(
        "guest_developer_tools",
        "Automatic Command Line Tools installation failed.",
      );
    progress(
      "macos.verifying",
      "Verifying guest SSH, FileVault, architecture, clock and developer tools.",
    );
    const verified = await executeGuest(connection, macSetupVerification, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (verified.exitCode !== 0)
      throw new VectisError("guest_verification_failed", "Guest verification did not complete.");
    verifyMacSetupOutput(verified.stdout);
    progress("macos.shutting_down", "Shutting down the verified guest before registration.");
    // SSH can disconnect as shutdown starts; the helper exit is the completion evidence.
    await executeGuest(connection, "sudo -n /sbin/shutdown -h now", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    }).catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      const cancel = () =>
        reject(new VectisError("macos_shutdown_failed", "Clean guest shutdown was not confirmed."));
      deadline.addEventListener("abort", cancel, { once: true });
      if (deadline.aborted) cancel();
      void boot.stopped.then(
        (clean) => {
          deadline.removeEventListener("abort", cancel);
          if (clean) resolve();
          else
            reject(
              new VectisError("macos_shutdown_failed", "Guest did not confirm a clean shutdown."),
            );
        },
        (error: unknown) => {
          deadline.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
    signal.throwIfAborted();
    const receipt = Schema.decodeUnknownSync(Schema.Struct({ instanceId: Schema.String }))(
      JSON.parse(await readFile(join(record.directory, "exit-receipt.json"), "utf8")),
    );
    if (receipt.instanceId !== record.attemptId) throw new Error("Missing shutdown receipt.");
    store.put("macInstallation", record.id, {
      ...record,
      bundle,
      phase: "setup_required",
      sshVerifiedAttempt: record.attemptId,
    });
    progress("macos.registering", "Registering the verified, stopped macOS environment.");
    const environment = await completedMacEnvironment(store, record.id);
    await runtime.validate(environment);
    store.put("environment", environment.id, environment);
    completeMacRegistration(store, environment);
    store.update(operation, {
      status: "succeeded",
      message: "macOS environment is ready.",
      result: {
        setupId: record.id,
        environmentId: environment.id,
        phase: "registered",
        setupMode: "automatic",
      },
    });
  } finally {
    password = "";
    boot.stop();
    await boot.stopped;
  }
}
