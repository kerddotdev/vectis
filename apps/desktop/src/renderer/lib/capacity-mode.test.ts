import { describe, expect, it } from "vitest";
import type { MachineRepositories } from "../../../../../packages/protocol/src/repositories.js";
import { scaleSetPresentation, scaleSetUnavailableReason } from "./capacity-mode";

const binding: MachineRepositories[number] = {
  id: "binding",
  repositoryId: 1,
  repositoryName: "acme/app",
  environmentId: "linux",
  automatic: true,
  capacityMode: "scale_set",
};

describe("scaleSetUnavailableReason", () => {
  it("blocks switching restricted policies to a scale set", () => {
    const demand = { ...binding, capacityMode: "demand" as const };
    expect(scaleSetUnavailableReason(demand)).toBeUndefined();
    expect(
      scaleSetUnavailableReason({
        ...demand,
        access: { actors: { ids: [7] }, approval: "automatic" },
      }),
    ).toBeDefined();
    expect(
      scaleSetUnavailableReason({ ...demand, access: { actors: "any", approval: "required" } }),
    ).toBeDefined();
  });

  it("never blocks leaving a scale set", () => {
    expect(
      scaleSetUnavailableReason({ ...binding, access: { actors: "any", approval: "required" } }),
    ).toBeUndefined();
  });
});

describe("scaleSetPresentation", () => {
  it("summarizes assigned jobs and reserved runners while listening", () => {
    expect(
      scaleSetPresentation(
        binding,
        { bindingId: "binding", state: "listening", assignedJobs: 2, reservedRunners: 1 },
        false,
      ),
    ).toEqual({
      tone: "running",
      label: "Listening",
      detail: "2 jobs assigned · 1 runner reserved",
    });
    expect(
      scaleSetPresentation(binding, { bindingId: "binding", state: "listening" }, false).detail,
    ).toBe("No jobs assigned");
  });

  it("explains why a scale set is not listening", () => {
    expect(scaleSetPresentation({ ...binding, automatic: false }, undefined, false)).toMatchObject({
      label: "Stopped",
      detail: "Turn on Automatic to receive jobs.",
    });
    expect(
      scaleSetPresentation(binding, { bindingId: "binding", state: "stopped" }, true).detail,
    ).toBe("New VMs are paused. Resume them in Overview.");
    expect(scaleSetPresentation(binding, undefined, false).label).toBe("Status unavailable");
  });

  it("surfaces action required with the service message", () => {
    expect(
      scaleSetPresentation(
        binding,
        {
          bindingId: "binding",
          state: "action_required",
          code: "x",
          message: "Check the binding.",
        },
        false,
      ),
    ).toEqual({ tone: "attention", label: "Action required", detail: "Check the binding." });
  });
});
