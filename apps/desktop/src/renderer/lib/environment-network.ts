import type { Egress, Environment, Snapshot } from "../../../../../packages/protocol/src/index.js";
import type { Tone } from "@/components/status";

export type EnvironmentView = Snapshot["environments"][number];

export interface NetworkDisplay {
  tone: Tone;
  label: string;
}

export function networkDisplay(environment: EnvironmentView): NetworkDisplay | undefined {
  const { network } = environment;
  if (!network) return undefined;
  if (network.enforcement === "not_enforced") {
    return { tone: "attention", label: "Open, not restricted" };
  }
  return network.egress === "internet_only"
    ? { tone: "success", label: "Internet only" }
    : { tone: "attention", label: "Open network access" };
}

export function canRestrictNetwork(os: Environment["os"]): boolean {
  return os === "windows";
}

export function currentEgress(environment: EnvironmentView): Egress {
  const { network } = environment;
  if (network?.enforcement === "enforced") return network.egress;
  return canRestrictNetwork(environment.os) ? (environment.egress ?? "internet_only") : "open";
}

export interface ConfigureDraft {
  rosetta: boolean;
  egress: Egress;
}

export function initialDraft(environment: EnvironmentView): ConfigureDraft {
  return { rosetta: environment.x64 === "rosetta", egress: currentEgress(environment) };
}

export function networkChanges(
  environment: EnvironmentView,
  draft: ConfigureDraft,
): { x64?: "rosetta" | "off"; egress?: Egress } {
  const initial = initialDraft(environment);
  return {
    ...(environment.os === "linux" && draft.rosetta !== initial.rosetta
      ? { x64: draft.rosetta ? ("rosetta" as const) : ("off" as const) }
      : {}),
    ...(canRestrictNetwork(environment.os) && draft.egress !== initial.egress
      ? { egress: draft.egress }
      : {}),
  };
}
