import { describe, expect, it } from "vitest";
import { resultCodePresentation } from "./result-code";

describe("result code presentation", () => {
<<<<<<< HEAD
  it("reads GitHub outages and rate limits as an external condition", () => {
    for (const code of ["github_unavailable", "github_rate_limited"]) {
      expect(resultCodePresentation({ code, nextStep: "Wait and retry." })).toEqual({
        tone: "attention",
        label: "GitHub degraded",
      });
    }
  });

  it("ignores local failures and non-objects", () => {
    expect(resultCodePresentation({ code: "job_refresh_failed" })).toBeUndefined();
    expect(resultCodePresentation("github_unavailable")).toBeUndefined();
=======
  it("labels runner recovery outcomes", () => {
    expect(resultCodePresentation({ code: "runner_recovery_pending" })).toEqual({
      tone: "attention",
      label: "Recovering after restart",
    });
    expect(resultCodePresentation({ code: "runner_interrupted" })?.tone).toBe("cancelled");
    expect(resultCodePresentation({ code: "runner_registration_failed" })?.tone).toBe("danger");
    expect(resultCodePresentation({ code: "runner_offline" })?.label).toBe("Runner offline");
  });

  it("ignores unknown codes and non-objects", () => {
    expect(resultCodePresentation({ code: "toString" })).toBeUndefined();
    expect(resultCodePresentation({ code: "other" })).toBeUndefined();
>>>>>>> fix/runner-self-recovery
    expect(resultCodePresentation(undefined)).toBeUndefined();
  });
});
