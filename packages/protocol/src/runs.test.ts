import { expect, test } from "vitest";
import { decodeCommand, commandActivity } from "./index.js";

const dispatch = {
  type: "workflow.dispatch",
  bindingId: "binding",
  workflow: "ci.yml",
  ref: "main",
};
test("run commands are intents and dispatch inputs respect count and byte limits", () => {
  for (const type of ["run.rerun-failed", "run.cancel", "workflow.dispatch"] as const)
    expect(commandActivity[type]).toBe("intent");
  expect(decodeCommand({ ...dispatch, inputs: { target: "staging", empty: "" } })).toMatchObject({
    inputs: { target: "staging", empty: "" },
  });
  expect(() =>
    decodeCommand({
      ...dispatch,
      inputs: Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [`key${index}`, "value"]),
      ),
    }),
  ).toThrow();
  expect(() => decodeCommand({ ...dispatch, inputs: { target: "x".repeat(65535) } })).toThrow();
  expect(() => decodeCommand({ ...dispatch, inputs: { target: "é".repeat(33000) } })).toThrow();
  expect(() => decodeCommand({ ...dispatch, inputs: { "invalid.key": "value" } })).toThrow();
});
test.each(["../ci.yml", "ci.yml/dispatches", 0, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid workflow identifier %s",
  (workflow) => {
    expect(() => decodeCommand({ ...dispatch, workflow })).toThrow();
  },
);
test.each([
  "@",
  "",
  "main..other",
  "main branch",
  "refs/heads/.hidden",
  "main.lock",
  "branch\\escape",
])("rejects invalid workflow ref %s", (ref) => {
  expect(() => decodeCommand({ ...dispatch, ref })).toThrow();
});
