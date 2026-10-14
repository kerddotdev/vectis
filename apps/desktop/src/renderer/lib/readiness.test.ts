import { expect, test } from "vitest";
import type { ReadinessCheck } from "../../../../../packages/protocol/src/readiness.js";
import { readinessRoute, readinessSection, summarizeReadiness } from "./readiness.js";

const check = (id: string, status: ReadinessCheck["status"]): ReadinessCheck => ({
  id,
  status,
  message: id,
});

test("the worst check decides the summary, and a blocker is named", () => {
  expect(summarizeReadiness([]).status).toBe("ok");
  expect(summarizeReadiness([check("a", "ok"), check("b", "attention")]).status).toBe("attention");
  expect(summarizeReadiness([check("a", "attention"), check("b", "unknown")]).status).toBe(
    "unknown",
  );
  const summary = summarizeReadiness([
    check("cloud", "ok"),
    check("account", "unknown"),
    check("app", "blocked"),
    check("admin", "blocked"),
    check("environment", "ok"),
  ]);
  expect(summary.status).toBe("blocked");
  expect(summary.blocking?.id).toBe("app");
  expect(summary.passed.map((item) => item.id)).toEqual(["cloud", "environment"]);
  expect(summary.open.map((item) => item.id)).toEqual(["account", "app", "admin"]);
});

test("GitHub targets open the GitHub part of Connections", () => {
  expect(readinessRoute({ area: "github" })).toBe("/connections");
  expect(readinessSection({ area: "github" })).toBe("github");
  expect(readinessSection({ area: "environments", section: "env-1" })).toBe("env-1");
  expect(readinessSection({ area: "connections" })).toBeUndefined();
});
