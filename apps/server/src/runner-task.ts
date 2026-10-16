import {
  VectisError,
  type Environment,
  type Instance,
} from "../../../packages/protocol/src/index.js";
import type {
  PhaseName,
  RunnerBroker,
  RunnerPhase,
  RunnerProgress,
} from "../../../packages/protocol/src/runners.js";
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
  jobStartedMarker,
  runnerGateScript,
} from "../../../packages/runner/src/runner-access.js";

const idleTimeoutMs = 5 * 60 * 1000;
const pollIntervalMs = 30000;

interface Controls {
  broker: RunnerBroker;
  needed?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  request?: Parameters<RunnerBroker["prepareRunner"]>[3];
  now?: () => number;
  acceptedAt?: string;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  offlineTimeoutMs?: number;
  statusFailureTimeoutMs?: number;
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
  const now = controls.now ?? Date.now;
  const taskStartedAt = new Date(now()).toISOString();
  let progress: RunnerProgress = {
    bindingId,
    environmentId: environment.id,
    leaseKey: key,
    stage: "starting",
    phases: [
      {
        name: "queued_locally",
        startedAt: controls.acceptedAt ?? taskStartedAt,
        endedAt: taskStartedAt,
      },
    ],
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
  const beginPhase = (name: PhaseName, at = now()) => {
    const phase: RunnerPhase = { name, startedAt: new Date(at).toISOString() };
    const phases = [...(progress.phases ?? [])];
    if (phases.length >= 16) {
      // Repeated idle-demand checks must not evict the startup timeline.
      const oldestCheck = phases.findIndex((item) => item.name === "job_check" && item.endedAt);
      if (oldestCheck < 0) throw new Error("Runner phase history is full.");
      phases.splice(oldestCheck, 1);
    }
    update({ phases: [...phases, phase] });
    return phase;
  };
  const endPhase = (phase: RunnerPhase, at = now()) => {
    const endedAt = new Date(at).toISOString();
    update({
      phases: progress.phases?.map((item) => (item === phase ? { ...item, endedAt } : item)),
    });
  };
  const timed = async <T>(name: PhaseName, work: () => Promise<T>) => {
    const phase = beginPhase(name);
    try {
      return await work();
    } finally {
      endPhase(phase);
    }
  };
  const needed = controls.request?.scaleSet ? undefined : controls.needed;
  const watchedControls = {
    ...controls,
    needed: needed ? (signal: AbortSignal) => timed("job_check", () => needed(signal)) : undefined,
  };
  update({});
  try {
    signal.throwIfAborted();
    if (watchedControls.needed && !(await watchedControls.needed(signal)))
      throw new VectisError(
        "job_not_queued",
        "The GitHub job no longer needs queued runner capacity.",
      );
    signal.throwIfAborted();
    started = true;
    const instance = await timed(
      environment.x64 === "rosetta" ? "vm_start_and_guest_ready" : "vm_start",
      () => controls.start(),
    );
    update({ instanceId: instance.id, stage: "preparing_guest" });
    signal.throwIfAborted();
    connection = await timed("guest_ready", () => readyGuest(environment, instance, signal));
    const shell = environment.os === "windows" ? "powershell" : "bash";
    const guest = connection;
    const installed = await timed("runner_install", () =>
      executeGuest(guest, runnerInstallScript(environment.os), {
        shell,
        signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
      }),
    );
    if (installed.exitCode !== 0)
      throw new VectisError(
        "runner_install_failed",
        "The verified runner installation failed.",
        "Inspect the base image prerequisites before starting a fresh runner.",
      );
    if (watchedControls.needed && !(await watchedControls.needed(signal)))
      throw new VectisError(
        "job_not_queued",
        "The GitHub job no longer needs queued runner capacity.",
      );
    update({ stage: "registering" });
    const registration = beginPhase("registration");
    registrationUncertain = true;
    const grant = await controls.broker
      .prepareRunner(bindingId, key, signal, controls.request)
      .catch((error: unknown) => {
        if (
          error instanceof VectisError &&
          ["cloud_unavailable", "cloud_unconfigured"].includes(error.code)
        ) {
          registrationUncertain = false;
          throw new VectisError(
            "runner_registration_failed",
            "Runner registration could not start because the cloud connection is unavailable.",
          );
        }
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
    const registeredAt = now();
    endPhase(registration, registeredAt);
    update({ runnerId: grant.runnerId, stage: "listening" });
    const waiting = beginPhase("waiting_for_job", registeredAt);
    let job: RunnerPhase | undefined;
    let listenerExitedAt: number | undefined;
    let guestStartObserved = false;
    const jobStarted = (reportedAt?: number) => {
      if (
        guestStartObserved ||
        (reportedAt === undefined && (job || listenerExitedAt !== undefined))
      )
        return;
      guestStartObserved = reportedAt !== undefined;
      const at = Math.max(registeredAt, Math.min(reportedAt ?? now(), listenerExitedAt ?? now()));
      const startedAt = new Date(at).toISOString();
      update({
        phases: progress.phases?.map((phase) =>
          phase.name === "waiting_for_job" ? { ...phase, endedAt: startedAt } : phase,
        ),
      });
      if (job) {
        job = {
          ...job,
          startedAt,
          ...(listenerExitedAt !== undefined
            ? { endedAt: new Date(listenerExitedAt).toISOString() }
            : {}),
        };
        const corrected = job;
        update({
          phases: progress.phases?.map((phase) => (phase.name === "job" ? corrected : phase)),
        });
      } else {
        job = beginPhase("job", at);
        if (listenerExitedAt !== undefined) endPhase(job, listenerExitedAt);
      }
    };
    const listening = new AbortController();
    const listeningSignal = AbortSignal.any([signal, listening.signal]);
    const watcher = watchIdleRunner(grant.id, watchedControls, listening, listeningSignal, () => {
      jobStarted();
    });
    const execution = await executeRunnerListener(
      connection,
      environment.os,
      runnerStartScript(environment.os, grant.encodedConfig, grant.access),
      listeningSignal,
      jobStarted,
      () => {
        listenerExitedAt = now();
        endPhase(job ?? waiting, listenerExitedAt);
      },
    )
      .catch((error: unknown) => {
        if (!signal.aborted && listening.signal.reason instanceof VectisError)
          throw listening.signal.reason;
        if (error instanceof GuestUnavailableError) listener = `connection lost: ${error.detail}`;
        throw error;
      })
      .finally(async () => {
        listening.abort();
        await watcher;
      });
    if (!signal.aborted && listening.signal.reason instanceof VectisError)
      throw listening.signal.reason;
    if (execution.exitCode !== 0) {
      listener = `exit ${execution.exitCode}\n${execution.stdout}\n${execution.stderr}`;
      throw new VectisError(
        "runner_process_failed",
        "The runner process exited unsuccessfully.",
        "Inspect the GitHub Actions run and the base image prerequisites.",
      );
    }
  } catch (error) {
    for (const phase of progress.phases ?? []) if (!phase.endedAt) endPhase(phase);
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
  const cleanupResult = await timed("cleanup", async () => {
    update({
      stage: "cleaning",
      ...(failure instanceof VectisError && failure.code === "runner_assignment_rejected"
        ? { cause: { code: failure.code, message: failure.message } }
        : {}),
    });
    if (started) {
      try {
        await controls.stop();
      } catch {
        return {
          status: "action_required" as const,
          progress,
          message: progress.cause
            ? "Vectis refused the assigned job. VM cleanup is unconfirmed and GitHub runner cleanup is waiting."
            : "VM cleanup is unconfirmed. The runner registration was retained.",
          code: "runner_cleanup_required",
          ...(failure instanceof VectisError && failure.code === "runner_offline"
            ? { recoveryCause: { code: failure.code, message: failure.message } }
            : {}),
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
          message: progress.cause
            ? "Vectis refused the assigned job. The VM is stopped and cleanup is waiting for GitHub to release the runner."
            : "The VM is stopped, but GitHub runner cleanup is waiting for reconciliation.",
          code: "runner_cleanup_required",
          ...(failure instanceof VectisError && failure.code === "runner_offline"
            ? { recoveryCause: { code: failure.code, message: failure.message } }
            : {}),
        };
      }
    }
    if (registrationUncertain) {
      if (
        failure instanceof VectisError &&
        ["public_runner_approval_required", "private_runner_approval_required"].includes(
          failure.code,
        )
      )
        return {
          status: "action_required" as const,
          progress,
          message: failure.message,
          code: failure.code,
          nextStep: `${failure.nextStep} Then run vectis runner reconcile with this operation ID to close the stopped runner attempt.`,
        };
      try {
        const lease = await controls.broker.reconcileRunner(
          { bindingId, environmentId: environment.id, key },
          AbortSignal.timeout(10000),
        );
        if (lease.bindingId !== bindingId || lease.environmentId !== environment.id)
          throw new Error("Runner lease identity mismatch.");
        update({ leaseId: lease.id });
        if (lease.phase !== "released")
          await controls.broker.releaseRunner(lease.id, AbortSignal.timeout(60000));
        failure = new VectisError(
          "runner_registration_failed",
          "Runner registration failed; cleanup is confirmed and the request can be retried.",
        );
      } catch {
        return {
          status: "action_required" as const,
          progress,
          message: "The VM is stopped. Reconcile the registration request before retrying.",
          code: "runner_registration_uncertain",
        };
      }
    }
  });
  if (cleanupResult) return { ...cleanupResult, progress };
  update({ stage: "finished" });
  if (failure instanceof VectisError && failure.code === "runner_idle")
    return { status: "cancelled" as const, progress, message: failure.message, code: failure.code };
  if (failure instanceof VectisError && failure.code === "job_not_queued")
    return { status: "cancelled" as const, progress, message: failure.message };
  if (
    signal.aborted &&
    !(
      failure instanceof VectisError &&
      ["runner_assignment_rejected", "runner_offline"].includes(failure.code)
    )
  )
    return { status: "cancelled" as const, progress, message: "Runner cancelled and cleaned up." };
  if (
    failure instanceof VectisError &&
    ["rosetta_not_installed", "rosetta_unsupported", "rosetta_guest_unprepared"].includes(
      failure.code,
    )
  )
    return {
      status: "action_required" as const,
      progress,
      message: failure.message,
      code: failure.code,
      nextStep: failure.nextStep,
    };
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

function guestJobStartedAt(output: string) {
  const lines = output.split(/\r?\n/);
  const marker = lines.indexOf(jobStartedMarker);
  const value = marker === -1 ? undefined : lines[marker + 1]?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

async function executeRunnerListener(
  connection: GuestConnection,
  os: Environment["os"],
  script: string,
  signal: AbortSignal,
  onJobStarted: (at: number) => void,
  onExit: () => void,
) {
  const listening = new AbortController();
  const monitoring = new AbortController();
  const shell = os === "windows" ? "powershell" : "bash";
  let rejection: VectisError | undefined;
  let checking: Promise<void> | undefined;
  const check = async (checkSignal: AbortSignal) => {
    try {
      const result = await executeGuest(connection, runnerGateScript(os), {
        shell,
        signal: AbortSignal.any([checkSignal, AbortSignal.timeout(10000)]),
      });
      rejection ??= assignmentRejection(result.stdout);
      if (rejection) listening.abort();
      else if (result.exitCode === 0) {
        const startedAt = guestJobStartedAt(result.stdout);
        if (startedAt !== undefined) onJobStarted(startedAt);
      }
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
      onExit();
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

async function watchIdleRunner(
  leaseId: string,
  controls: Controls,
  listening: AbortController,
  signal: AbortSignal,
  onBusy: () => void,
) {
  const now = controls.now ?? Date.now;
  const timeoutMs = controls.idleTimeoutMs ?? idleTimeoutMs;
  const offlineTimeout = controls.offlineTimeoutMs ?? 2 * 60 * 1000;
  const failureTimeout = controls.statusFailureTimeoutMs ?? 15 * 60 * 1000;
  let idleSince = now();
  let offlineSince: number | undefined;
  let failureSince: number | undefined;
  const offline = () =>
    listening.abort(
      new VectisError(
        "runner_offline",
        "The runner is offline or its GitHub status has been unavailable too long; the VM is being released.",
      ),
    );
  const readStatus = async () => {
    try {
      const status = await controls.broker.runnerStatus(leaseId, signal);
      failureSince = undefined;
      return status;
    } catch {
      if (!signal.aborted) {
        failureSince ??= now();
        offlineSince = undefined;
        if (now() - failureSince >= failureTimeout) offline();
      }
      return undefined;
    }
  };
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, controls.pollIntervalMs ?? pollIntervalMs);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    if (signal.aborted) return;
    const status = await readStatus();
    if (signal.aborted) return;
    if (!status) continue;
    if ("busy" in status && status.busy) {
      onBusy();
      idleSince = now();
      offlineSince = undefined;
      continue;
    }
    if ("missing" in status || status.status === "offline") {
      offlineSince ??= now();
      if (now() - offlineSince >= offlineTimeout) offline();
      continue;
    }
    offlineSince = undefined;
    if (now() - idleSince < timeoutMs) continue;
    try {
      if (controls.needed && (await controls.needed(signal))) continue;
    } catch {
      continue;
    }
    if (signal.aborted) return;
    // Refreshing the job may take long enough for GitHub to assign this runner work.
    const confirmed = await readStatus();
    if (signal.aborted) return;
    if (!confirmed) continue;
    if ("busy" in confirmed && confirmed.busy) {
      onBusy();
      idleSince = now();
      continue;
    }
    if ("missing" in confirmed || confirmed.status === "offline") {
      offlineSince ??= now();
      continue;
    }
    listening.abort(
      new VectisError(
        "runner_idle",
        "The runner was idle for 5 minutes and no longer needs capacity; the VM is being released.",
      ),
    );
  }
}
