import { describe, expect, it } from "vitest";
import {
  budgetLimits,
  committedShare,
  defaultBudgetMiB,
  derivedImageDirectory,
  instanceDisplay,
  isPoolInstance,
  pressureDisplay,
  setupScriptTooLarge,
  stepBudget,
  type MemoryBudget,
} from "./vm-capacity";

const budget: MemoryBudget = {
  memoryBudgetMiB: 24576,
  memoryCommittedMiB: 8192,
  hostMemoryMiB: 32768,
  pressure: "normal",
  pressureKnown: true,
};

describe("memory budget", () => {
  it("stays between 2 GiB and host memory, which the service enforces", () => {
    expect(budgetLimits(32768)).toEqual({ min: 2048, max: 32768 });
    expect(stepBudget(2048, -1, 32768)).toBe(2048);
    expect(stepBudget(32000, 1, 32768)).toBe(32768);
    expect(stepBudget(13824, 1, 32768)).toBe(14848);
  });

  it("matches the service default of 75% of host memory", () => {
    expect(defaultBudgetMiB(18432)).toBe(13824);
    expect(defaultBudgetMiB(16383.9)).toBe(12287);
  });

  it("does not report normal pressure when the host cannot measure it", () => {
    expect(pressureDisplay({ ...budget, pressureKnown: false }).tone).toBe("unsupported");
    expect(pressureDisplay({ ...budget, pressure: "critical" }).tone).toBe("danger");
    expect(pressureDisplay({ ...budget, pressure: "warning" }).tone).toBe("attention");
    expect(pressureDisplay(budget).tone).toBe("success");
  });

  it("clamps the committed share for the meter", () => {
    expect(committedShare(budget)).toBe(1 / 3);
    expect(committedShare({ ...budget, memoryCommittedMiB: 40000 })).toBe(1);
  });
});

describe("pool instances", () => {
  it("labels warm VMs separately from job VMs", () => {
    expect(instanceDisplay({ status: "running", role: "warm" }).label).toBe("Warm");
    expect(instanceDisplay({ status: "starting", role: "warming" }).label).toBe("Warming");
    expect(instanceDisplay({ status: "running" }).label).toBe("Running");
  });

  it("treats a stopped former pool VM as stopped, not warm", () => {
    expect(isPoolInstance({ status: "stopped", role: "warm" })).toBe(false);
    expect(instanceDisplay({ status: "stopped", role: "warm" }).label).toBe("Stopped");
  });
});

describe("derived environments", () => {
  it("measures the setup script limit in UTF-8 bytes", () => {
    expect(setupScriptTooLarge("a".repeat(65536))).toBe(false);
    expect(setupScriptTooLarge("é".repeat(32769))).toBe(true);
  });

  it("puts the image in a new folder inside the chosen one", () => {
    expect(derivedImageDirectory("/Volumes/VMs/", "ubuntu-custom")).toBe(
      "/Volumes/VMs/ubuntu-custom",
    );
    expect(derivedImageDirectory("/", "ubuntu-custom")).toBe("/ubuntu-custom");
  });
});
