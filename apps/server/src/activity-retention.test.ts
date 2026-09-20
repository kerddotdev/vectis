import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Operation } from "../../../packages/protocol/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { activityFor } from "./activities.js";
import { retainActivities } from "./activity-retention.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-21T12:00:00Z");
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-retention-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "state.sqlite"));
  cleanup.push(() => store.close());
  const add = (id: string, age: number, status: Operation["status"] = "succeeded") => {
    const operation = store.accept(
      id,
      id,
      "job.scan",
      activityFor(id, { type: "job.scan", bindingId: "binding" }),
      id,
    ).operation;
    store.put("operation", id, {
      ...operation,
      status,
      updatedAt: new Date(now - age * day).toISOString(),
    });
    return operation;
  };
  return { store, home, add };
}

test("age retention prunes finished history after 30 days, preserves resources and tombstones", async () => {
  const { store, add } = await fixture();
  const old = add("old", 31, "failed");
  add("boundary", 30);
  add("young", 2);
  for (const kind of [
    "preparation",
    "macInstallation",
    "windowsInstallation",
    "instance",
    "environment",
  ])
    store.put(
      kind,
      "owned",
      kind === "environment"
        ? {
            id: "owned",
            name: "Owned",
            os: "linux",
            basePath: "/unused",
            cpu: 1,
            memoryMiB: 512,
            state: "ready",
          }
        : kind === "instance"
          ? {
              id: "owned",
              environmentId: "owned",
              status: "stopped",
              pid: 0,
              createdAt: "2020-01-01",
            }
          : { id: "owned", phase: "interrupted" },
    );
  const resources = store.db
    .prepare("SELECT * FROM records WHERE kind NOT IN ('operation','activity')")
    .all();
  retainActivities(store, () => false, now);
  expect(
    store
      .snapshot()
      .activities?.map((activity) => activity.id)
      .sort(),
  ).toEqual(["boundary", "young"]);
  expect(store.get("operation", old.id)).toBeUndefined();
  expect(
    store.db.prepare("SELECT * FROM records WHERE kind NOT IN ('operation','activity')").all(),
  ).toEqual(resources);
  expect(() => store.accept("old", "old", "job.scan")).toThrow(
    expect.objectContaining({ code: "operation_expired", nextStep: "Use a new request key." }),
  );
  expect(() => store.accept("old", "different", "machine.pause")).toThrow(
    expect.objectContaining({ code: "operation_expired" }),
  );
  store.update(old, { message: "Late completion" });
  expect(store.get("operation", old.id)).toBeUndefined();
});

test("count retention uses completion order and preserves the recent tail regardless of its size", async () => {
  const { store, add } = await fixture();
  add("oldest", 3);
  for (let index = 0; index < 300; index++) add(`recent-${index}`, 0.5);
  add("older-but-created-last", 2);
  add("day-boundary", 1);
  retainActivities(store, () => false, now);
  expect(store.snapshot().activities).toHaveLength(301);
  expect(store.get("activity", "oldest")).toBeUndefined();
  expect(store.get("activity", "older-but-created-last")).toBeUndefined();
  expect(store.get("activity", "day-boundary")).toBeDefined();
});

test("age and count limits combine while waiting and actively owned work survive both", async () => {
  const { store, add } = await fixture();
  add("old", 40);
  add("overflow", 2);
  add("waiting", 60, "action_required");
  add("active", 60, "cancelled");
  add("unfinished-child", 60);
  const child = store.accept("child", "child", "instance.stop", {
    activityId: "unfinished-child",
  }).operation;
  for (let index = 0; index < 300; index++) add(`recent-${index}`, 0.5);
  retainActivities(store, (id) => id === "active", now);
  expect(store.get("activity", "old")).toBeUndefined();
  expect(store.get("activity", "overflow")).toBeUndefined();
  for (const id of ["waiting", "active", "unfinished-child"])
    expect(store.get("activity", id)).toBeDefined();
  expect(store.get("operation", child.id)).toBeDefined();
});

test("unlinked maintenance expires only after terminal completion and never while owned", async () => {
  const { store } = await fixture();
  for (const [id, command, age, status] of [
    ["setting", "machine.pause", 2, "succeeded"],
    ["scan", "job.scan", 2, "failed"],
    ["waiting", "job.scan", 60, "action_required"],
    ["accepted", "job.scan", 60, "accepted"],
    ["running", "job.scan", 60, "running"],
    ["fresh", "machine.pause", 0.5, "cancelled"],
    ["active", "job.scan", 60, "succeeded"],
  ] as const) {
    const operation = store.accept(id, id, command, undefined, id).operation;
    store.put("operation", id, {
      ...operation,
      status,
      updatedAt: new Date(now - age * day).toISOString(),
    });
  }
  retainActivities(store, (id) => id === "active", now);
  expect(
    store
      .snapshot()
      .operations.map((op) => op.id)
      .sort(),
  ).toEqual(["accepted", "active", "fresh", "running", "waiting"]);
});

test("the service sweeps after initialization and hourly, then releases its timer on close", async () => {
  const { store, home, add } = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  add("startup", 40);
  const service = new Service(store, new VmRuntime({ home }));
  try {
    await service.initialize();
    expect(store.get("activity", "startup")).toBeUndefined();
    add("hourly", 40);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(store.get("activity", "hourly")).toBeUndefined();
  } finally {
    await service.close();
  }
  add("after-close", 40);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(store.get("activity", "after-close")).toBeDefined();
  expect(vi.getTimerCount()).toBe(0);
});
