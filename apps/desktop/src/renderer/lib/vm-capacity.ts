import type { Instance, RunnerCapacity } from "../../../../../packages/protocol/src/index.js";
import type { Tone } from "@/components/status";

export type MemoryBudget = NonNullable<RunnerCapacity["budget"]>;

const minimumBudgetMiB = 2048;
const budgetStepMiB = 1024;

export function budgetLimits(hostMemoryMiB: number) {
  return { min: minimumBudgetMiB, max: Math.max(minimumBudgetMiB, Math.floor(hostMemoryMiB)) };
}

export function defaultBudgetMiB(hostMemoryMiB: number) {
  return Math.floor(hostMemoryMiB * 0.75);
}

export function stepBudget(currentMiB: number, direction: 1 | -1, hostMemoryMiB: number) {
  const { min, max } = budgetLimits(hostMemoryMiB);
  return Math.min(max, Math.max(min, currentMiB + direction * budgetStepMiB));
}

export function pressureDisplay(budget: MemoryBudget): { tone: Tone; label: string } {
  if (budget.pressureKnown === false) return { tone: "unsupported", label: "Pressure unknown" };
  if (budget.pressure === "critical") return { tone: "danger", label: "Memory pressure critical" };
  if (budget.pressure === "warning") return { tone: "attention", label: "Memory pressure high" };
  return { tone: "success", label: "Memory pressure normal" };
}

export function committedShare(budget: MemoryBudget) {
  if (budget.memoryBudgetMiB <= 0) return 0;
  return Math.min(1, Math.max(0, budget.memoryCommittedMiB / budget.memoryBudgetMiB));
}

export function isPoolInstance(instance: Pick<Instance, "role" | "status">) {
  return !!instance.role && (instance.status === "starting" || instance.status === "running");
}

export function instanceDisplay(instance: Pick<Instance, "role" | "status">): {
  tone: Tone;
  label: string;
} {
  if (isPoolInstance(instance))
    return instance.role === "warm"
      ? { tone: "idle", label: "Warm" }
      : { tone: "queued", label: "Warming" };
  const states = {
    starting: { tone: "queued", label: "Starting" },
    running: { tone: "running", label: "Running" },
    stopped: { tone: "idle", label: "Stopped" },
    interrupted: { tone: "attention", label: "Interrupted" },
  } as const satisfies Record<Instance["status"], { tone: Tone; label: string }>;
  return states[instance.status];
}

export const setupScriptLimitBytes = 65536;

export function setupScriptTooLarge(script: string) {
  return new TextEncoder().encode(script).length > setupScriptLimitBytes;
}

export function derivedImageDirectory(picked: string, id: string) {
  const parent = picked.replace(/\/+$/, "");
  return id ? `${parent}/${id}` : parent;
}
