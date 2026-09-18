import {
  VectisError,
  type Environment,
  type Instance,
} from "../../../packages/protocol/src/index.js";
import type { RunnerBroker, RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest } from "../../../packages/runner/src/guest.js";
import {
  runnerInstallScript,
  runnerStartScript,
} from "../../../packages/runner/src/runner-release.js";

interface Controls {
  broker: RunnerBroker;
  start(): Promise<Instance>;
  stop(): Promise<void>;
  progress(value: RunnerProgress): void;
}

export async function runRunnerTask(
  bindingId: string,
  key: string,
  environment: Environment,
  controls: Controls,
  signal: AbortSignal,
) {
  let progress: RunnerProgress = {
    bindingId,
    environmentId: environment.id,
    leaseKey: key,
    stage: "starting",
  };
  let started = false;
  let registrationUncertain = false;
  let failure: unknown;
  const update = (patch: Partial<RunnerProgress>) => {
    progress = { ...progress, ...patch };
    controls.progress(progress);
  };
  update({});
  try {
    signal.throwIfAborted();
    started = true;
    const instance = await controls.start();
    update({ instanceId: instance.id, stage: "preparing_guest" });
    signal.throwIfAborted();
    const connection = await readyGuest(environment, instance, signal);
    const shell = environment.os === "windows" ? "powershell" : "bash";
    const installed = await executeGuest(connection, runnerInstallScript(environment.os), {
      shell,
      signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
    });
    if (installed.exitCode !== 0)
      throw new VectisError(
        "runner_install_failed",
        "The verified runner installation failed.",
        "Inspect the base image prerequisites before starting a fresh runner.",
      );
    update({ stage: "registering" });
    registrationUncertain = true;
    const grant = await controls.broker.prepareRunner(bindingId, key, signal);
    update({ leaseId: grant.id });
    registrationUncertain = false;
    if (grant.state !== "ready")
      throw new VectisError(
        "runner_registration_incomplete",
        "Runner registration needs reconciliation.",
      );
    if (grant.environmentId !== environment.id || grant.os !== environment.os)
      throw new VectisError(
        "runner_identity_mismatch",
        "The runner grant targets another environment.",
      );
    update({ runnerId: grant.runnerId, stage: "listening" });
    const execution = await executeGuest(
      connection,
      runnerStartScript(environment.os, grant.encodedConfig),
      {
        shell,
        signal: AbortSignal.any([signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]),
      },
    );
    if (execution.exitCode !== 0)
      throw new VectisError(
        "runner_process_failed",
        "The runner process exited unsuccessfully.",
        "Inspect the GitHub Actions run and the base image prerequisites.",
      );
  } catch (error) {
    failure = error;
  }
  {
    update({ stage: "cleaning" });
    if (started) {
      try {
        await controls.stop();
      } catch {
        return {
          status: "action_required" as const,
          progress,
          message: "VM cleanup is unconfirmed. The runner registration was retained.",
          code: "runner_cleanup_required",
        };
      }
    }
    if (progress.leaseId) {
      try {
        await controls.broker.releaseRunner(progress.leaseId, AbortSignal.timeout(60000));
      } catch {
        return {
          status: "action_required" as const,
          progress,
          message: "The VM is stopped, but GitHub runner cleanup needs reconciliation.",
          code: "runner_cleanup_required",
        };
      }
    }
  }
  if (registrationUncertain)
    return {
      status: "action_required" as const,
      progress,
      message: "The VM is stopped. Reconcile the registration request before retrying.",
      code: "runner_registration_uncertain",
    };
  update({ stage: "finished" });
  if (signal.aborted)
    return { status: "cancelled" as const, progress, message: "Runner cancelled and cleaned up." };
  if (failure)
    return {
      status: "failed" as const,
      progress,
      message: failure instanceof VectisError ? failure.message : "Runner execution failed.",
      code: failure instanceof VectisError ? failure.code : "runner_failed",
    };
  return {
    status: "succeeded" as const,
    progress,
    message: "Runner lifecycle completed and cleaned up. Check GitHub for the job result.",
  };
}
