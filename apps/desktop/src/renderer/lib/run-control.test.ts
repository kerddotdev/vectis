import { expect, test } from "vitest";
import {
  inputsRecord,
  pendingRunIds,
  runActions,
  validateInputs,
  validateRef,
  validateWorkflow,
} from "./run-control";

test("offers cancel for active runs and rerun only for failed completed runs", () => {
  expect(runActions({ status: "in_progress", conclusion: null })).toEqual({
    cancel: true,
    rerun: false,
  });
  expect(runActions({ status: "completed", conclusion: "timed_out" }).rerun).toBe(true);
  expect(runActions({ status: "completed", conclusion: "success" })).toEqual({
    cancel: false,
    rerun: false,
  });
});

test("keeps a run busy until its submitted operation settles", () => {
  const submitted = new Map([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  const pending = pendingRunIds(submitted, [
    { id: "a", command: "run.cancel", status: "running" },
    { id: "b", command: "run.rerun-failed", status: "action_required" },
  ]);
  expect([...pending].sort()).toEqual([1, 3]);
});

test("rejects empty, malformed and duplicate input names", () => {
  const errors = validateInputs([
    { id: 1, key: "env", value: "" },
    { id: 2, key: " ", value: "" },
    { id: 3, key: "env", value: "" },
    { id: 4, key: "9x", value: "" },
  ]);
  expect([...errors.keys()]).toEqual([2, 3, 4]);
  expect(inputsRecord([{ id: 1, key: " env ", value: "prod" }])).toEqual({ env: "prod" });
});

test("validates workflow file names and refs", () => {
  expect(validateWorkflow("ci.yml")).toBeUndefined();
  expect(validateWorkflow("../ci.yml")).toBeDefined();
  expect(validateRef("release/1.0")).toBeUndefined();
  expect(validateRef("a..b")).toBeDefined();
  expect(validateRef("")).toBeDefined();
});
