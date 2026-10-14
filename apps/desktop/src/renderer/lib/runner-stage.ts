import type { Activity, Operation } from "../../../../../packages/protocol/src/index.js";
import { Schema } from "effect";
import { RunnerProgress } from "../../../../../packages/protocol/src/runners.js";
import type { Tone } from "@/components/status";

export type RunnerStageKey = Exclude<RunnerProgress["stage"], "finished"> | "runner_idle";

const stages = {
  starting: ["queued", "Starting VM"],
  preparing_guest: ["running", "Preparing runner"],
  registering: ["running", "Registering"],
  listening: ["queued", "Waiting for job"],
  cleaning: ["running", "Cleaning up"],
  runner_idle: ["cancelled", "Released idle runner"],
} as const satisfies Record<RunnerStageKey, readonly [Tone, string]>;

export function runnerStagePresentation(stage: RunnerStageKey) {
  const [tone, label] = stages[stage];
  return { tone, label };
}

const StageResult = Schema.Struct({
  stage: RunnerProgress.fields.stage,
  code: Schema.optional(Schema.String),
});
const isStageResult = Schema.is(StageResult);

export function runnerStageFromResult(result: unknown): RunnerStageKey | undefined {
  if (!isStageResult(result)) return undefined;
  if (result.code === "runner_idle") return "runner_idle";
  return result.stage === "finished" ? undefined : result.stage;
}

// The stage is only news while the runner works or when it handed back an idle runner.
export function activeRunnerStage(
  activity: Activity,
  root: Operation | undefined,
  jobStatus?: string,
) {
  if (activity.subject.type !== "runner" || !root) return undefined;
  const stage = runnerStageFromResult(root.result);
  if (stage === "runner_idle") return activity.status === "cancelled" ? stage : undefined;
  // Once GitHub reports the job running, its own status says the same thing.
  if (stage === "listening" && jobStatus === "in_progress") return undefined;
  return activity.status === "accepted" || activity.status === "running" ? stage : undefined;
}

export function isGeneratedStageMessage(message: string) {
  return /^Runner: [a-z_]+\.$/.test(message);
}

export function findRunnerActivity(
  job: { jobId: number; status?: string },
  activities: readonly Activity[],
  operations: readonly Operation[],
) {
  for (const activity of activities) {
    if (activity.subject.type !== "runner") continue;
    const linked = (activity.subject.actualJob ?? activity.subject.requestedJob)?.jobId;
    if (linked !== job.jobId) continue;
    const root = operations.find((operation) => operation.id === activity.rootOperationId);
    const stage = activeRunnerStage(activity, root, job.status);
    if (stage) return stage;
  }
  return undefined;
}
