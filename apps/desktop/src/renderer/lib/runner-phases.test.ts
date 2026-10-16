import { describe, expect, it } from "vitest";
import { formatDuration, runnerPhaseTimeline } from "./runner-phases";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const phase = (name: string, start: number, end?: number) => ({
  name,
  startedAt: at(start),
  ...(end === undefined ? {} : { endedAt: at(end) }),
});
const base = { stage: "finished", leaseKey: "key" };

describe("formatDuration", () => {
  it.each([
    [40, "< 0.1 s"],
    [100, "0.1 s"],
    [5_800, "5.8 s"],
    [9_960, "10 s"],
    [32_400, "32 s"],
    [59_600, "1 min"],
    [72_000, "1 min 12 s"],
    [3_600_000, "1 h"],
    [3_960_000, "1 h 6 min"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("runnerPhaseTimeline", () => {
  it("ignores results without phases", () => {
    expect(runnerPhaseTimeline(base, { end: 0, active: false })).toBeUndefined();
    expect(runnerPhaseTimeline({ ...base, phases: [] }, { end: 0, active: false })).toBeUndefined();
    expect(runnerPhaseTimeline(undefined, { end: 0, active: false })).toBeUndefined();
  });

  it("measures the span, not the sum, when idle checks overlap waiting", () => {
    const timeline = runnerPhaseTimeline(
      {
        ...base,
        phases: [
          phase("vm_start", 0, 5.8),
          phase("registration", 5.8, 8.4),
          phase("waiting_for_job", 8.4, 40.4),
          phase("job_check", 10, 10.5),
          phase("job_check", 20, 20.5),
          phase("job", 40.4, 55.4),
          phase("cleanup", 55.4, 57.1),
        ],
      },
      { end: 999_999, active: false },
    );
    expect(timeline?.total).toBe("57 s");
    expect(timeline?.rows.map((row) => [row.label, row.duration, row.count])).toEqual([
      ["VM start", "5.8 s", 1],
      ["Registration", "2.6 s", 1],
      ["Waiting for job", "32 s", 1],
      ["Job check", "1.0 s", 2],
      ["Job", "15 s", 1],
      ["Cleanup", "1.7 s", 1],
    ]);
    const checks = timeline?.rows.find((row) => row.name === "job_check");
    expect(checks?.segments).toHaveLength(2);
    expect(checks?.segments[0]?.offset).toBeCloseTo(10 / 57.1);
  });

  it("runs an open phase until now while the runner is active", () => {
    const result = { ...base, phases: [phase("vm_start", 0, 6), phase("waiting_for_job", 6)] };
    const now = Date.parse(at(18));
    const running = runnerPhaseTimeline(result, { end: now, active: true });
    expect(running?.rows.at(-1)).toMatchObject({ state: "running", duration: "12 s" });
    expect(running?.total).toBe("18 s");
    expect(runnerPhaseTimeline(result, { end: now, active: false })?.rows.at(-1)?.state).toBe(
      "unfinished",
    );
  });

  it("keeps phases from a newer service readable and drops invalid timestamps", () => {
    const timeline = runnerPhaseTimeline(
      {
        ...base,
        phases: [phase("snapshot_restore", 0, 2), { name: "vm_start", startedAt: "soon" }],
      },
      { end: 0, active: false },
    );
    expect(timeline?.rows.map((row) => row.label)).toEqual(["Snapshot restore"]);
  });
});
