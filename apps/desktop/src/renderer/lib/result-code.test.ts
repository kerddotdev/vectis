import { describe, expect, it } from "vitest";
import { resultCodePresentation } from "./result-code";

describe("result code presentation", () => {
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
    expect(resultCodePresentation(undefined)).toBeUndefined();
  });
});
