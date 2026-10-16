import { Schema } from "effect";
import { expect, test } from "vitest";
import { RunnerProgress } from "./runners.js";

const legacy = {
  bindingId: "binding",
  environmentId: "linux",
  leaseKey: "operation",
  stage: "listening",
};
const phase = {
  name: "vm_start",
  startedAt: "2026-10-16T00:00:00.000Z",
  endedAt: "2026-10-16T00:00:12.300Z",
};
const decode = Schema.decodeUnknownSync(RunnerProgress, { onExcessProperty: "error" });

test("runner progress decodes older snapshots without phases", () => {
  expect(decode(legacy)).toEqual(legacy);
});

test("runner progress retains completed, active and preinstalled phases", () => {
  const progress = {
    ...legacy,
    phases: [
      phase,
      { name: "runner_preinstalled", startedAt: phase.endedAt },
      { ...phase, name: "vm_start_and_guest_ready" },
    ],
  };
  expect(decode(progress)).toEqual(progress);
});

test("runner phase history is bounded and rejects unknown phase names", () => {
  expect(
    decode({ ...legacy, phases: Array.from({ length: 16 }, () => phase) }).phases,
  ).toHaveLength(16);
  expect(() => decode({ ...legacy, phases: Array.from({ length: 17 }, () => phase) })).toThrow();
  expect(() => decode({ ...legacy, phases: [{ ...phase, name: "unknown" }] })).toThrow();
});
