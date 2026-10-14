import {
  VectisError,
  type Environment,
  type Instance,
} from "../../../packages/protocol/src/index.js";
import type { RunnerBroker, RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import type { GuestConnection } from "../../../packages/runner/src/guest.js";
import { collectRunnerDiagnostics } from "../../../packages/runner/src/guest-diagnostics.js";
import {
  runnerInstallScript,
  runnerStartScript,
} from "../../../packages/runner/src/runner-release.js";

import {
  assignmentRejectedMarker,
  assignmentRejectedScript,
} from "../../../packages/runner/src/runner-access.js";

interface Controls {
  broker: RunnerBroker;
  needed?: () => Promise<boolean>;
  request?: { jobId?: number; automatic?: boolean };
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
  let connection: GuestConnection | undefined;
  let listener = "";
  let secret = "";
  const update = (patch: Partial<RunnerProgress>) => {
    progress = { ...progress, ...patch };
    controls.progress(progress);
  };
  update({});
  try {
    signal.throwIfAborted();
    if (controls.needed && !(await controls.needed()))
      throw new VectisError(
        "job_not_queued",
        "The GitHub job no longer needs queued runner capacity.",
      );
    signal.throwIfAborted();
    started = true;
    const instance = await controls.start();
    update({ instanceId: instance.id, stage: "preparing_guest" });
    signal.throwIfAborted();
    connection = await readyGuest(environment, instance, signal);
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
    if (controls.needed && !(await controls.needed()))
      throw new VectisError(
        "job_not_queued",
        "The GitHub job no longer needs queued runner capacity.",
      );
    update({ stage: "registering" });
    registrationUncertain = true;
    const grant = await controls.broker
      .prepareRunner(bindingId, key, signal, controls.request)
      .catch((error: unknown) => {
        if (
          error instanceof VectisError &&
          [
            "actor_not_allowed",
            "actor_unknown",
            "approval_required",
            "job_required",
            "job_not_queued",
            "automatic_disabled",
            "repository_access_changed",
            "runner_labels_mismatch",
          ].includes(error.code)
        )
          registrationUncertain = false;
        throw error;
      });
    if (grant.state === "ready") secret = grant.encodedConfig;
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
    if (!grant.access)
      throw new VectisError(
        "runner_policy_missing",
        "The runner grant has no repository assignment policy.",
      );
    update({ runnerId: grant.runnerId, stage: "listening" });
    const execution = await executeRunnerListener(
      connection,
      environment.os,
      runnerStartScript(environment.os, grant.encodedConfig, grant.access),
      signal,
    ).catch((error: unknown) => {
      if (error instanceof GuestUnavailableError) listener = `connection lost: ${error.detail}`;
      throw error;
    });
    if (execution.exitCode !== 0) {
      listener = `exit ${execution.exitCode}\n${execution.stdout}\n${execution.stderr}`;
      throw new VectisError(
        "runner_process_failed",
        "The runner process exited unsuccessfully.",
        "Inspect the GitHub Actions run and the base image prerequisites.",
      );
    }
  } catch (error) {
    failure = error;
  }
  if (
    connection &&
    !signal.aborted &&
    failure instanceof VectisError &&
    ["guest_unavailable", "runner_process_failed"].includes(failure.code)
  )
    update({
      diagnostics: await collectRunnerDiagnostics({
        connection,
        os: environment.os,
        listener,
        secrets: [secret],
      }).catch(() => undefined),
    });
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
  if (registrationUncertain) {
    if (
      failure instanceof VectisError &&
      ["public_runner_approval_required", "private_runner_approval_required"].includes(failure.code)
    )
      return {
        status: "action_required" as const,
        progress,
        message: failure.message,
        code: failure.code,
        nextStep: `${failure.nextStep} Then run vectis runner reconcile with this operation ID to close the stopped runner attempt.`,
      };
    return {
      status: "action_required" as const,
      progress,
      message: "The VM is stopped. Reconcile the registration request before retrying.",
      code: "runner_registration_uncertain",
    };
  }
  update({ stage: "finished" });
  if (failure instanceof VectisError && failure.code === "job_not_queued")
    return { status: "cancelled" as const, progress, message: failure.message };
  if (
    signal.aborted &&
    !(failure instanceof VectisError && failure.code === "runner_assignment_rejected")
  )
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

function assignmentRejection(output: string) {
  const lines = output.split(/\r?\n/);
  const marker = lines.indexOf(assignmentRejectedMarker);
  if (marker === -1) return undefined;
  const reason = lines[marker + 1]?.trim() || "binding access policy";
  return new VectisError(
    "runner_assignment_rejected",
    `Vectis refused the assigned GitHub job: ${reason}.`,
  );
}

async function executeRunnerListener(
  connection: GuestConnection,
  os: Environment["os"],
  script: string,
  signal: AbortSignal,
) {
  const listening = new AbortController();
  const monitoring = new AbortController();
  const shell = os === "windows" ? "powershell" : "bash";
  let rejection: VectisError | undefined;
  let checking: Promise<void> | undefined;
  const check = async (checkSignal: AbortSignal) => {
    try {
      const result = await executeGuest(connection, assignmentRejectedScript(os), {
        shell,
        signal: AbortSignal.any([checkSignal, AbortSignal.timeout(10000)]),
      });
      rejection ??= assignmentRejection(result.stdout);
      if (rejection) listening.abort();
    } catch {
      // A transient guest connection failure is not evidence of policy rejection.
    }
  };
  const timer = setInterval(() => {
    if (checking || rejection) return;
    checking = check(AbortSignal.any([signal, monitoring.signal])).finally(() => {
      checking = undefined;
    });
  }, 10000);
  const outcome = await executeGuest(connection, script, {
    shell,
    signal: AbortSignal.any([signal, listening.signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]),
  })
    .then(
      (execution) => ({ execution }),
      (error: unknown) => ({ error }),
    )
    .finally(async () => {
      clearInterval(timer);
      monitoring.abort();
      await checking;
    });
  if (!rejection && !signal.aborted) await check(signal);
  if ("execution" in outcome) {
    rejection ??= assignmentRejection(outcome.execution.stdout);
    rejection ??= assignmentRejection(outcome.execution.stderr);
  }
  if (rejection) throw rejection;
  if ("error" in outcome) throw outcome.error;
  return outcome.execution;
}
