import { expect, test } from "vitest";
import type { ReadinessCheck } from "../../../../../packages/protocol/src/readiness.js";
import {
  readinessFailure,
  readinessRoute,
  readinessSection,
  summarizeReadiness,
} from "./readiness.js";

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

test.each(["unknown_query", "not_found"])(
  "unsupported readiness (%s) is unavailable rather than an error",
  (code) => {
    const issue = Object.assign(new Error("The service does not support this query."), { code });
    expect(readinessFailure(issue)).toEqual({ unavailable: true });
  },
);

test.each(["inspection_failed", "remote_query_timeout", "repository_access_denied"])(
  "readiness failures (%s) remain errors",
  (code) => {
    const issue = Object.assign(new Error("The request failed."), { code });
    expect(readinessFailure(issue)).toEqual({ error: issue.message });
  },
);
