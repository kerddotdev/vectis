import { describe, expect, it } from "vitest";
import { resultCodePresentation } from "./result-code";

describe("result code presentation", () => {
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
    expect(resultCodePresentation(undefined)).toBeUndefined();
  });
});
