import type { Environment } from "../../protocol/src/index.js";

// The only label a workflow needs in runs-on to reach this environment.
export const workflowLabel = (environmentId: string) => `vectis-${environmentId}`;

export function runnerLabels(os: Environment["os"], environmentId: string) {
  return [
    "self-hosted",
    { linux: "Linux", macos: "macOS", windows: "Windows" }[os],
    "ARM64",
    `vectis-${environmentId}`,
  ];
}

export function matchesRunnerLabels(
  requested: readonly string[],
  os: Environment["os"],
  environmentId: string,
) {
  const available = new Set(runnerLabels(os, environmentId).map((label) => label.toLowerCase()));
  const labels = requested.map((label) => label.toLowerCase());
  return (
    labels.includes(`vectis-${environmentId}`.toLowerCase()) &&
    labels.every((label) => available.has(label))
  );
}
