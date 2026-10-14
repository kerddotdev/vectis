import type { Operation } from "../../../../../packages/protocol/src/index.js";
import type { Job } from "../../../../../packages/protocol/src/jobs.js";

export const maxDispatchInputs = 25;

const rerunnableConclusions = ["failure", "timed_out", "cancelled"];

export type RunActions = { cancel: boolean; rerun: boolean };

export function runActions(job: Pick<Job, "status" | "conclusion">): RunActions {
  return {
    cancel: job.status !== "completed",
    rerun: job.status === "completed" && rerunnableConclusions.includes(job.conclusion ?? ""),
  };
}

const runCommands = ["run.cancel", "run.rerun-failed"];

// Operations do not carry their command input, so the app remembers which operation it
// submitted for each run and keeps the run busy until that operation settles.
export function pendingRunIds(
  submitted: ReadonlyMap<number, string>,
  operations: readonly Pick<Operation, "id" | "command" | "status">[],
): Set<number> {
  const pending = new Set<number>();
  for (const [runId, operationId] of submitted) {
    const operation = operations.find((item) => item.id === operationId);
    if (!operation) {
      pending.add(runId);
      continue;
    }
    if (
      runCommands.includes(operation.command) &&
      (operation.status === "accepted" || operation.status === "running")
    )
      pending.add(runId);
  }
  return pending;
}

export type InputRow = { id: number; key: string; value: string };

const keyPattern = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;

export function validateInputs(rows: readonly InputRow[]): Map<number, string> {
  const errors = new Map<number, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") errors.set(row.id, "Enter an input name.");
    else if (!keyPattern.test(key))
      errors.set(row.id, "Use letters, digits, - and _, starting with a letter or _.");
    else if (seen.has(key)) errors.set(row.id, "Input names must be unique.");
    seen.add(key);
  }
  return errors;
}

export function inputsRecord(rows: readonly InputRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
}

const workflowPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/;

export function validateWorkflow(workflow: string): string | undefined {
  if (workflow.trim() === "") return "Enter a workflow file name.";
  if (!workflowPattern.test(workflow.trim()))
    return "Use the workflow file name, for example ci.yml.";
  return undefined;
}

export function validateRef(ref: string): string | undefined {
  const value = ref.trim();
  if (value === "") return "Enter a branch or tag.";
  if (value.startsWith("-") || /[\s~^:?*[\\]/.test(value) || value.includes(".."))
    return "This is not a valid branch or tag name.";
  return undefined;
}
