import { expect, test } from "vitest";
import type { ActivityDetail, Snapshot } from "../../../../../packages/protocol/src/index.js";
import { mergeActivityDetail } from "./activity-detail.js";

test("opening an old activity restores its omitted steps without losing current machine state", () => {
  const detail: ActivityDetail = {
    activity: {
      id: "old",
      kind: "vectis",
      subject: { type: "command", command: "job.scan" },
      rootOperationId: "root",
      status: "succeeded",
      message: "Done",
      createdAt: "2020-01-01",
      updatedAt: "2020-01-02",
    },
    operations: ["root", "child"].map((id) => ({
      id,
      key: id,
      activityId: "old",
      command: "job.scan",
      status: "succeeded",
      message: "Done",
      createdAt: "2020-01-01",
      updatedAt: "2020-01-02",
    })),
  };
  const snapshot: Snapshot = {
    protocolVersion: 1,
    revision: "service:42",
    machine: { id: "host", name: "Host", paused: false },
    environments: [],
    instances: [],
    activities: [],
    operations: [
      {
        id: "other",
        key: "other",
        activityId: "other",
        command: "job.scan",
        status: "running",
        message: "Running",
        createdAt: "2026-10-16",
        updatedAt: "2026-10-16",
      },
    ],
  };
  const merged = mergeActivityDetail(snapshot, detail);
  expect(merged.activities).toEqual([detail.activity]);
  expect(merged.operations.map(({ id }) => id)).toEqual(["other", "child", "root"]);
  expect(merged.revision).toBe(snapshot.revision);
  expect(merged.machine).toBe(snapshot.machine);
  expect(snapshot.activities).toEqual([]);
  expect(mergeActivityDetail(merged, detail)).toEqual(merged);
});
