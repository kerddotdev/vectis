import { Schema } from "effect";
import type { Command, Operation } from "../../../packages/protocol/src/index.js";
import type { MachineRepositories } from "../../../packages/protocol/src/repositories.js";
import {
  infrastructureFailureCodes,
  RunnerProgress,
} from "../../../packages/protocol/src/runners.js";
import type { Store } from "./store.js";

const Decision = Schema.Struct({
  bindingId: Schema.String,
  runId: Schema.Int,
  attempt: Schema.Int,
  runnerOperationId: Schema.String,
  settled: Schema.optional(Schema.Boolean),
  infraJobIds: Schema.Array(Schema.Int),
});

export function reconcileInfraReruns(
  store: Store,
  bindings: MachineRepositories,
  submit: (key: string, command: Extract<Command, { type: "run.rerun-failed" }>) => Operation,
) {
  const activities = store.activitySummaries();
  for (const activity of activities) {
    if (activity.subject.type !== "runner") continue;
    const job = activity.subject.actualJob;
    if (
      job?.status !== "completed" ||
      job.conclusion !== "failure" ||
      !job.runId ||
      !job.runAttempt
    )
      continue;
    if (store.get("operation", activity.rootOperationId) === undefined) continue;
    const operation = store.operation(activity.rootOperationId);
    if (operation.status !== "failed") continue;
    const decoded = Schema.decodeUnknownOption(RunnerProgress)(operation.result);
    if (decoded._tag === "None") continue;
    const progress = decoded.value;
    if (!infrastructureFailureCodes.includes(progress.recoveryCause?.code ?? "")) continue;
    if (!bindings.some((binding) => binding.id === progress.bindingId && binding.infraRerun))
      continue;
    const key = `infra-rerun:${progress.bindingId}:${job.runId}:${job.runAttempt}`;
    // Reserve the next attempt even if GitHub acceptance is uncertain after a crash.
    if (
      store.get(
        "infra-rerun",
        `infra-rerun:${progress.bindingId}:${job.runId}:${job.runAttempt - 1}`,
      )
    )
      continue;
    if (!store.get("infra-rerun", key))
      store.put("infra-rerun", key, {
        bindingId: progress.bindingId,
        runId: job.runId,
        attempt: job.runAttempt,
        runnerOperationId: operation.id,
        infraJobIds: activities
          .flatMap((candidate) => {
            if (candidate.subject.type !== "runner" || candidate.bindingId !== progress.bindingId)
              return [];
            const actual = candidate.subject.actualJob;
            if (
              !actual ||
              actual.runId !== job.runId ||
              actual.runAttempt !== job.runAttempt ||
              actual.conclusion !== "failure"
            )
              return [];
            if (store.get("operation", candidate.rootOperationId) === undefined) return [];
            const runner = store.operation(candidate.rootOperationId);
            const state = Schema.decodeUnknownOption(RunnerProgress)(runner.result);
            return runner.status === "failed" &&
              state._tag === "Some" &&
              infrastructureFailureCodes.includes(state.value.recoveryCause?.code ?? "")
              ? [actual.jobId]
              : [];
          })
          .sort((a, b) => a - b)
          .slice(0, 256),
      });
  }
  for (const value of store.list("infra-rerun")) {
    const decision = Schema.decodeUnknownSync(Decision)(value);
    if (decision.settled) continue;
    const key = `infra-rerun:${decision.bindingId}:${decision.runId}:${decision.attempt}`;
    if (!bindings.some((binding) => binding.id === decision.bindingId && binding.infraRerun))
      continue;
    const rerun = submit(key, {
      type: "run.rerun-failed",
      bindingId: decision.bindingId,
      runId: decision.runId,
      expectedRunAttempt: decision.attempt,
      infraJobIds: [...decision.infraJobIds],
    });
    const waiting = Schema.is(Schema.Struct({ code: Schema.Literal("run_not_ready") }))(
      rerun.result,
    );
    if (
      rerun.status === "succeeded" ||
      (rerun.status === "failed" && !waiting) ||
      rerun.status === "cancelled"
    )
      store.put("infra-rerun", key, { ...decision, settled: true });
    if (store.get("operation", decision.runnerOperationId) === undefined) continue;
    const runner = store.operation(decision.runnerOperationId);
    if (!Schema.is(RunnerProgress)(runner.result)) continue;
    const infraRerun = { runId: decision.runId, attempt: decision.attempt, operationId: rerun.id };
    if (runner.result.infraRerun?.operationId !== rerun.id)
      store.update(runner, { result: { ...runner.result, infraRerun } });
  }
}
