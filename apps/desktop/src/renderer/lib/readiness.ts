import type {
  ReadinessCheck,
  ReadinessTarget,
} from "../../../../../packages/protocol/src/readiness.js";

const routes = {
  connections: "/connections",
  environments: "/environments",
  repositories: "/repositories",
  diagnostics: "/diagnostics",
  settings: "/settings",
  github: "/connections",
} as const satisfies Record<ReadinessTarget["area"], string>;

export const areaLabels = {
  connections: "Connections",
  environments: "Environments",
  repositories: "Repositories",
  diagnostics: "Diagnostics",
  settings: "Settings",
  github: "GitHub connections",
} as const satisfies Record<ReadinessTarget["area"], string>;

export function readinessRoute(target: ReadinessTarget) {
  return routes[target.area];
}

export function readinessSection(target: ReadinessTarget) {
  return target.section ?? (target.area === "github" ? "github" : undefined);
}

export function sectionId(name: string) {
  return `section-${name}`;
}

export type ReadinessStatus = ReadinessCheck["status"];

const severity = { ok: 0, attention: 1, unknown: 2, blocked: 3 } as const satisfies Record<
  ReadinessStatus,
  number
>;

export function summarizeReadiness(checks: readonly ReadinessCheck[]) {
  const status = checks.reduce<ReadinessStatus>(
    (worst, check) => (severity[check.status] > severity[worst] ? check.status : worst),
    "ok",
  );
  return {
    status,
    passed: checks.filter((check) => check.status === "ok"),
    open: checks.filter((check) => check.status !== "ok"),
    blocking: checks.find((check) => check.status === "blocked"),
  };
}

export function readinessFailure(issue: unknown) {
  if (
    issue instanceof Error &&
    "code" in issue &&
    (issue.code === "unknown_query" || issue.code === "not_found")
  )
    return { unavailable: true };
  return { error: issue instanceof Error ? issue.message : "The request failed." };
}
