import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "./store.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.restoreAllMocks();
});

async function legacy() {
  const home = await mkdtemp(join(tmpdir(), "vectis-migration-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "state.sqlite");
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  db.exec(`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL);`);
  const originals = new Map<string, object>();
  const insert = (id: string, command: string, result?: unknown, key = id) => {
    const operation = {
      id,
      key,
      command,
      result,
      status: "succeeded",
      createdAt: `2026-01-${String(originals.size + 1).padStart(2, "0")}T00:00:00Z`,
      updatedAt: "2026-02-01T00:00:00Z",
      message: "Legacy result",
      futureField: { keep: [1, "two"] },
    };
    originals.set(id, operation);
    db.prepare("INSERT INTO records VALUES('operation',?,?)").run(id, JSON.stringify(operation));
    db.prepare("INSERT INTO requests VALUES(?,?,?)").run(key, id, id);
  };
  db.exec("BEGIN");
  for (const name of [
    "install-macos",
    "open-macos-setup",
    "connect-macos-guest",
    "verify-macos-guest",
    "finish-macos-setup",
  ])
    insert(name, `environment.${name}`, { setupId: "setup" });
  insert("runner", "runner.run", {
    bindingId: "binding",
    environmentId: "image",
    leaseKey: "runner",
    stage: "finished",
  });
  insert("start", "environment.start", undefined, "runner:start");
  insert("stop", "instance.stop", undefined, "runner:stop");
  insert("cancel-start", "operation.cancel", undefined, "runner:cancel-start");
  insert("reconcile", "runner.reconcile", { operationId: "runner" });
  insert("setting", "repository.automatic");
  insert("scan", "job.scan", undefined, "remote:scan");
  db.exec("COMMIT");
  return { path, db, originals, insert };
}

test("migration groups only durable setup and runner evidence and preserves raw legacy fields", async () => {
  const { path, db, originals } = await legacy();
  const store = new Store(path);
  cleanup.push(() => store.close());
  const snapshot = store.snapshot();
  expect(snapshot.activities).toHaveLength(2);
  expect(snapshot.activities?.map((activity) => activity.id)).toEqual(["runner", "setup"]);
  for (const [id, raw] of originals) {
    const activityId =
      id === "setting" || id === "scan" ? undefined : id.includes("macos") ? "setup" : "runner";
    expect(store.get("operation", id)).toEqual(
      JSON.parse(JSON.stringify({ ...raw, ...(activityId ? { activityId } : {}) })),
    );
  }
  expect(store.get("activity", "setup")).toMatchObject({
    rootOperationId: "install-macos",
    createdAt: "2026-01-01T00:00:00Z",
    subject: { type: "preparation", setupId: "setup", os: "macos" },
  });
  expect(store.get("activity", "runner")).toMatchObject({
    kind: "github",
    bindingId: "binding",
    environmentId: "image",
  });
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(store.accept("runner:stop", "stop", "instance.stop").fresh).toBe(false);
});

test("a failure midway rolls back all links and bases and a later startup migrates exactly once", async () => {
  const { path, db, originals } = await legacy();
  db.exec(`CREATE TRIGGER reject_backfill BEFORE UPDATE ON records
    WHEN NEW.kind='operation' AND NEW.id='verify-macos-guest'
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
  expect(() => new Store(path)).toThrow("Activity migration failed: injected migration failure");
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
  expect(db.prepare("SELECT id FROM records WHERE kind='activity'").all()).toEqual([]);
  for (const [id, raw] of originals)
    expect(
      db.prepare("SELECT body FROM records WHERE kind='operation' AND id=?").get(id)?.body,
    ).toBe(JSON.stringify(raw));
  db.exec("DROP TRIGGER reject_backfill");
  const store = new Store(path);
  expect(store.snapshot().activities).toHaveLength(2);
  store.close();
  const reopened = new Store(path);
  cleanup.push(() => reopened.close());
  expect(reopened.snapshot().activities).toHaveLength(2);
  expect(reopened.snapshot().operations).toHaveLength(originals.size);
  expect(db.prepare("SELECT count(*) AS total FROM requests").get()?.total).toBe(originals.size);
});

test("missing setup evidence and unrelated intents never merge by environment or time", async () => {
  const { path, insert } = await legacy();
  insert("linux", "environment.resume");
  insert("windows", "environment.resume-windows", { setupId: "" });
  insert("future", "future.command", { environmentId: "image" });
  insert("manual-scan", "job.scan");
  const store = new Store(path);
  cleanup.push(() => store.close());
  expect(store.snapshot().activities).toHaveLength(6);
  expect(store.get("activity", "linux")).toMatchObject({
    subject: { setupId: "linux", os: "linux" },
  });
  expect(store.get("activity", "windows")).toMatchObject({
    subject: { setupId: "windows", os: "windows" },
  });
  expect(store.get("activity", "future")).toMatchObject({
    subject: { type: "command", command: "future.command" },
  });
});

test("unreadable legacy history stays intact while migration and recovery of valid work continue", async () => {
  const { path, db, originals } = await legacy();
  const unreadable = [
    [
      "old-format",
      JSON.stringify({ id: "old-format", command: "job.scan", obsoleteStatus: "done" }),
    ],
    ["broken-json", '{"id":'],
  ] as const;
  for (const [id, body] of unreadable) {
    db.prepare("INSERT INTO records VALUES('operation',?,?)").run(id, body);
    db.prepare("INSERT INTO requests VALUES(?,?,?)").run(id, id, id);
  }
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new Store(path);
  cleanup.push(() => store.close());
  expect(() => store.recover()).not.toThrow();
  expect(store.snapshot().operations).toHaveLength(originals.size);
  expect(store.snapshot().activities).toHaveLength(2);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  for (const [id, body] of unreadable) {
    expect(
      db.prepare("SELECT body FROM records WHERE kind='operation' AND id=?").get(id)?.body,
    ).toBe(body);
    expect(db.prepare("SELECT operation_id FROM requests WHERE key=?").get(id)?.operation_id).toBe(
      id,
    );
    expect(() => store.accept(id, id, "job.scan")).toThrow();
  }
  expect(warning).toHaveBeenCalledWith("Activity migration skipped 2 unreadable history records.");
  expect(store.activityMembers("runner")).toHaveLength(5);
});
