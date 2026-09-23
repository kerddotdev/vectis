import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Store } from "./store.js";

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
