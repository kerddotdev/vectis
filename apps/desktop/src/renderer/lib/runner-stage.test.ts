import { describe, expect, it } from "vitest";
import type { Activity, Operation } from "../../../../../packages/protocol/src/index.js";
import {
  activeRunnerStage,
  findRunnerActivity,
  isGeneratedStageMessage,
  runnerStageFromResult,
  runnerStagePresentation,
} from "./runner-stage";

const activity = (status: Activity["status"], jobId: number): Activity => ({
  id: `activity-${jobId}`,
  kind: "vectis",
  subject: { type: "runner", requestedJob: { jobId } },
  createdAt: "2026-01-01T00:00:00.000Z",
  rootOperationId: `op-${jobId}`,
  status,
  message: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const operation = (jobId: number, result: unknown): Operation => ({
  id: `op-${jobId}`,
  key: `key-${jobId}`,
  command: "runner.run",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  message: "",
  result,
});

describe("runner stage", () => {
  it("maps results to stages and hides finished", () => {
    expect(runnerStageFromResult({ stage: "preparing_guest" })).toBe("preparing_guest");
    expect(runnerStageFromResult({ stage: "finished" })).toBeUndefined();
    expect(runnerStageFromResult({ stage: "finished", code: "runner_idle" })).toBe("runner_idle");
    expect(runnerStageFromResult("nope")).toBeUndefined();
  });

  it("leaves a running job to GitHub's own status", () => {
    expect(runnerStagePresentation("listening").label).toBe("Waiting for job");
    const op = operation(1, { stage: "listening" });
    expect(activeRunnerStage(activity("running", 1), op, "in_progress")).toBeUndefined();
    expect(
      findRunnerActivity({ jobId: 1, status: "in_progress" }, [activity("running", 1)], [op]),
    ).toBeUndefined();
  });

  it("only reports stages for active runners or released idle runners", () => {
    const op = operation(1, { stage: "listening" });
    expect(activeRunnerStage(activity("running", 1), op)).toBe("listening");
    expect(activeRunnerStage(activity("succeeded", 1), op)).toBeUndefined();
    const idle = operation(1, { stage: "finished", code: "runner_idle" });
    expect(activeRunnerStage(activity("cancelled", 1), idle)).toBe("runner_idle");
  });

  it("links a job to the active runner that requested it", () => {
    const activities = [activity("succeeded", 1), activity("running", 2)];
    const operations = [operation(1, { stage: "listening" }), operation(2, { stage: "cleaning" })];
    expect(findRunnerActivity({ jobId: 2 }, activities, operations)).toBe("cleaning");
    expect(findRunnerActivity({ jobId: 1 }, activities, operations)).toBeUndefined();
    expect(findRunnerActivity({ jobId: 3 }, activities, operations)).toBeUndefined();
  });

  it("recognizes only the generated stage message", () => {
    expect(isGeneratedStageMessage("Runner: preparing_guest.")).toBe(true);
    expect(isGeneratedStageMessage("Runner failed: boom.")).toBe(false);
  });
});
