import type { ReadinessTarget } from "../../../../../packages/protocol/src/readiness.js";

const routes = {
  connections: "/connections",
  environments: "/environments",
  repositories: "/repositories",
  diagnostics: "/diagnostics",
  settings: "/settings",
  github: "/connections",
} as const satisfies Record<ReadinessTarget["area"], string>;

export function readinessRoute(target: ReadinessTarget) {
  return routes[target.area];
}
