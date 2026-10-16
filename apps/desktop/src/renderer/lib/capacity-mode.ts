import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import type {
  CapacityMode,
  ScaleSetState,
} from "../../../../../packages/protocol/src/scale-sets.js";
import { restrictiveAccess } from "../../../../../packages/github/src/access-policy.js";
import type { Tone } from "@/components/status";

type Binding = MachineRepositories[number];

export function capacityMode(binding: Binding): CapacityMode {
  return binding.capacityMode ?? "demand";
}

// The cloud refuses scale sets for restricted policies because scale set messages carry neither
// the workflow actor nor an approval decision.
export function scaleSetUnavailableReason(binding: Binding): string | undefined {
  if (capacityMode(binding) === "scale_set" || !restrictiveAccess(binding.access)) return undefined;
  return "Scale sets need open access: anyone who can run workflows, with no approval step.";
}

export interface ScaleSetPresentation {
  tone: Tone;
  label: string;
  detail?: string;
}

function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function scaleSetPresentation(
  binding: Binding,
  state: ScaleSetState | undefined,
  paused: boolean,
): ScaleSetPresentation {
  if (!binding.automatic && state?.state !== "listening")
    return { tone: "idle", label: "Stopped", detail: "Turn on Automatic to receive jobs." };
  if (!state) return { tone: "idle", label: "Status unavailable" };
  switch (state.state) {
    case "connecting":
      return { tone: "queued", label: "Connecting" };
    case "listening": {
      const assigned = state.assignedJobs ?? 0;
      const reserved = state.reservedRunners ?? 0;
      return {
        tone: "running",
        label: "Listening",
        detail: [
          assigned === 0 ? "No jobs assigned" : `${count(assigned, "job")} assigned`,
          ...(reserved > 0 ? [`${count(reserved, "runner")} reserved`] : []),
        ].join(" · "),
      };
    }
    case "action_required":
      return {
        tone: "attention",
        label: "Action required",
        detail:
          state.code === "scale_set_policy_unsupported"
            ? "Restricted access cannot use scale sets. Switch to Demand or open access."
            : (state.message ?? "Scale set listening stopped."),
      };
    case "stopped":
      return {
        tone: "idle",
        label: "Stopped",
        detail: paused
          ? "New VMs are paused. Resume them in Overview."
          : "Not listening right now.",
      };
  }
}
