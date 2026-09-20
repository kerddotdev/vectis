import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "./store.js";
import { activityFor } from "./activities.js";
import { Snapshot } from "../../../packages/protocol/src/index.js";
import { Schema } from "effect";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-store-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "state.sqlite");
  return { path, store: new Store(path) };
}

test("recovery never silently retries an uncertain side effect", async () => {
  const { store } = await fixture();
  try {
    const { operation } = store.accept("id", "fingerprint", "environment.start");
    store.update(operation, { status: "running" });
    store.recover();
    expect(store.snapshot().operations[0]?.status).toBe("action_required");
    expect(store.accept("id", "fingerprint", "environment.start").fresh).toBe(false);
  } finally {
    store.close();
  }
});

test("inactive setup prompts do not reserve capacity but unconfirmed guest processes do", async () => {
  const { store } = await fixture();
  try {
    store.put("macInstallation", "mac", { phase: "setup_required" });
    store.put("preparation", "linux", { phase: "interrupted" });
    expect(store.snapshot().preparationBusy).toBe(false);
    for (const phase of ["installing", "setup_running"]) {
      store.put("macInstallation", "mac", { phase });
      expect(store.snapshot().preparationBusy).toBe(true);
    }
    store.put("macInstallation", "mac", { phase: "registered" });
    store.put("preparation", "linux", { phase: "booting" });
    expect(store.snapshot().preparationBusy).toBe(true);
    store.put("preparation", "linux", { phase: "prepared" });
    expect(store.snapshot().preparationBusy).toBe(false);
  } finally {
    store.close();
  }
});

test("snapshot revisions distinguish writes, removals and external changes from reads", async () => {
  const { store } = await fixture();
  try {
    const initial = store.snapshot();
    expect(initial.revision).toEqual(expect.any(String));
    expect(initial.activities).toEqual([]);
    expect(store.snapshot().revision).toBe(initial.revision);
    store.put("machine", "self", { ...initial.machine, paused: true });
    const updated = store.snapshot();
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.machine.paused).toBe(true);
    const { operation } = store.accept("pause", "fingerprint", "machine.pause");
    const accepted = store.snapshot();
    store.remove("operation", operation.id);
    const removed = store.snapshot();
    expect(removed.revision).not.toBe(accepted.revision);
    expect(removed.operations).toEqual([]);
    store.touch();
    const touched = store.snapshot();
    expect(touched.revision).not.toBe(removed.revision);
    expect(store.snapshot()).toEqual(touched);
  } finally {
    store.close();
  }
});

test("snapshot readers can decode an older service with unknown revision and activities", async () => {
  const { store } = await fixture();
  try {
    const legacy = { ...store.snapshot() };
    delete legacy.revision;
    delete legacy.activities;
    const decoded = Schema.decodeUnknownSync(Snapshot, { onExcessProperty: "error" })(legacy);
    expect(decoded.revision).toBeUndefined();
    expect(decoded.activities ?? []).toEqual([]);
  } finally {
    store.close();
  }
});

test("replayed keys cannot create or relink activities, and stale writers preserve current fields", async () => {
  const { store } = await fixture();
  try {
    const command = { type: "runner.run", bindingId: "binding" } as const;
    const link = activityFor("root", command);
    const original = store.accept("run", "same", command.type, link, "root").operation;
    store.update(original, { result: { step: 1 } });
    store.update(original, { message: "Still running" });
    expect(store.get("operation", "root")).toMatchObject({
      activityId: "root",
      result: { step: 1 },
      message: "Still running",
    });
    const replay = store.accept(
      "run",
      "same",
      command.type,
      activityFor("wrong", command),
      "wrong",
    );
    expect(replay).toMatchObject({ fresh: false, operation: { id: "root", activityId: "root" } });
    expect(store.get("activity", "wrong")).toBeUndefined();
    expect(store.snapshot().activities).toHaveLength(1);
    store.remove("operation", "root");
    expect(store.snapshot().activities).toEqual([]);
    store.update(original, { status: "succeeded" });
    expect(store.get("operation", "root")).toBeUndefined();
  } finally {
    store.close();
  }
});

test("reopening the same database never reuses a snapshot revision", async () => {
  const { store, path } = await fixture();
  const previous = store.snapshot();
  store.close();
  const reopened = new Store(path);
  try {
    const current = reopened.snapshot();
    expect(current.machine).toEqual(previous.machine);
    expect(current.revision).not.toBe(previous.revision);
    reopened.touch();
    expect(reopened.snapshot().revision).not.toBe(previous.revision);
  } finally {
    reopened.close();
  }
});

test("an operation ID collision cannot overwrite another request or leave a new activity", async () => {
  const { store } = await fixture();
  try {
    const first = store.accept("first", "first", "machine.pause", undefined, "shared-id").operation;
    expect(() =>
      store.accept(
        "second",
        "second",
        "runner.run",
        activityFor("new-activity", { type: "runner.run", bindingId: "binding" }),
        first.id,
      ),
    ).toThrow();
    expect(store.get("operation", first.id)).toEqual(first);
    expect(store.get("activity", "new-activity")).toBeUndefined();
    expect(store.db.prepare("SELECT * FROM requests WHERE key='second'").get()).toBeUndefined();
    expect(store.accept("first", "first", "machine.pause")).toEqual({
      operation: first,
      fresh: false,
    });
  } finally {
    store.close();
  }
});

test("snapshot groups decoded history with bounded queries and preserves insertion order after updates", async () => {
  const { store } = await fixture();
  try {
    for (let index = 0; index < 40; index++) {
      const id = `setup-${index}`;
      const root = store.accept(
        id,
        id,
        "environment.install-macos",
        activityFor(id, { type: "environment.resume-macos", id }),
        id,
      ).operation;
      const step = store.accept(
        `verify-${index}`,
        id,
        "environment.verify-macos-guest",
        activityFor(`verify-${index}`, { type: "environment.verify-macos-guest", id }),
      ).operation;
      store.put("operation", step.id, {
        ...step,
        status: "succeeded",
        message: "Verified.",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      store.put("operation", root.id, {
        ...root,
        status: "failed",
        updatedAt: "2026-02-01T00:00:00Z",
      });
    }
    const queries = vi.spyOn(store.db, "prepare");
    try {
      const snapshot = store.snapshot();
      expect(snapshot.activities).toHaveLength(40);
      expect(
        snapshot.activities?.every(
          (activity) =>
            activity.status === "succeeded" &&
            activity.message === "Verified." &&
            activity.completedAt === "2026-01-01T00:00:00Z" &&
            activity.updatedAt === "2026-02-01T00:00:00Z",
        ),
      ).toBe(true);
      expect(queries.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      queries.mockRestore();
    }
  } finally {
    store.close();
  }
});
