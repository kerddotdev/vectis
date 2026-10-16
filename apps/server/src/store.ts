import { redact } from "../../../packages/client/src/redact.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Schema } from "effect";
import {
  ActivityBase,
  Environment,
  Instance,
  Machine,
  Operation,
  VectisError,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";
import { deriveActivity, type ActivityLink } from "./activities.js";
import { migrateStore } from "./store-migrations.js";
import { privateFile } from "./private-files.js";

function redactOperation(operation: Operation): Operation {
  return {
    ...operation,
    message: redact(operation.message),
    ...(operation.result === undefined
      ? {}
      : {
          result: JSON.parse(
            JSON.stringify(operation.result, (_key, value: unknown) =>
              typeof value === "string" ? redact(value) : value,
            ),
          ),
        }),
  };
}

const decodeOperation = Schema.decodeUnknownSync(Operation);
export const snapshotLimits = { operations: 100, activities: 100, stoppedInstances: 20 };
export type StoreOptions = { snapshotLimits?: typeof snapshotLimits };
const terminalStatuses = "('succeeded','failed','cancelled')";
function readOperation(body: unknown): Operation[] {
  if (typeof body !== "string") return [];
  try {
    return [decodeOperation(JSON.parse(body))];
  } catch {
    return [];
  }
}

export class Store {
  readonly db: DatabaseSync;
  readonly startId = randomUUID();
  private changes = 0;
  private listeners = new Set<() => void>();
  private readonly snapshotLimits: typeof snapshotLimits;
  constructor(path: string, options: StoreOptions = {}) {
    this.snapshotLimits = options.snapshotLimits ?? snapshotLimits;
    if (path !== ":memory:") {
      privateFile(path, true);
      privateFile(`${path}-wal`);
      privateFile(`${path}-shm`);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_by_activity ON records(json_extract(body,'$.activityId')) WHERE kind='operation' AND json_valid(body);`);
    try {
      migrateStore(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.get("machine", "self"))
      this.put("machine", "self", { id: randomUUID(), name: hostname(), paused: false });
  }
  close() {
    this.db.close();
  }
  get(kind: string, id: string): unknown {
    const row = this.db.prepare("SELECT body FROM records WHERE kind=? AND id=?").get(kind, id);
    return row && typeof row.body === "string" ? JSON.parse(row.body) : undefined;
  }
  list(kind: string): unknown[] {
    return this.db
      .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((row) => (typeof row.body === "string" ? JSON.parse(row.body) : null));
  }
  put(kind: string, id: string, body: unknown) {
    if (kind === "instance") {
      const instance = Schema.decodeUnknownSync(Instance)(body);
      if (instance.status === "stopped" && instance.stoppedAt === undefined) {
        const previous = this.get(kind, id);
        const stoppedAt =
          previous === undefined
            ? instance.createdAt
            : (Schema.decodeUnknownSync(Instance)(previous).stoppedAt ?? new Date().toISOString());
        body = { ...instance, stoppedAt };
      }
    }
    this.db
      .prepare(
        "INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(
        kind,
        id,
        JSON.stringify(kind === "operation" ? redactOperation(decodeOperation(body)) : body),
      );
    this.touch();
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
    this.touch();
  }
  touch() {
    this.changes++;
    for (const listener of this.listeners) listener();
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  activityMembers(activityId: string): Operation[] {
    return this.db
      .prepare(
        "SELECT body FROM records WHERE kind='operation' AND json_valid(body) AND json_extract(body,'$.activityId')=? ORDER BY rowid",
      )
      .all(activityId)
      .flatMap((row) => readOperation(row.body));
  }
  operation(id: string) {
    const value = this.get("operation", id);
    if (value === undefined)
      throw new VectisError("operation_missing", "The operation was not found.");
    return decodeOperation(value);
  }
  instance(id: string) {
    const value = this.get("instance", id);
    return value === undefined ? undefined : Schema.decodeUnknownSync(Instance)(value);
  }
  operationByKey(key: string) {
    const row = this.db.prepare("SELECT operation_id FROM requests WHERE key=?").get(key);
    if (!row) throw new VectisError("operation_missing", "The operation was not found.");
    return this.operation(String(row.operation_id));
  }
  activity(id: string) {
    const value = this.get("activity", id);
    const operations = this.activityMembers(id);
    const activity =
      value === undefined
        ? undefined
        : deriveActivity(Schema.decodeUnknownSync(ActivityBase)(value), operations);
    if (!activity) throw new VectisError("activity_missing", "The activity was not found.");
    return { activity, operations };
  }
  // Retention and job observation need retained history, independently of the status window.
  activitySummaries(terminalLimit?: number) {
    return this.db
      .prepare(`
      WITH summaries AS MATERIALIZED (
        SELECT a.body,
          (SELECT json_remove(o.body,'$.result') FROM records o
            WHERE o.kind='operation' AND json_valid(o.body)
              AND json_extract(o.body,'$.activityId')=json_extract(a.body,'$.id')
              AND (json_extract(a.body,'$.subject.type')='preparation'
                OR o.id=json_extract(a.body,'$.rootOperationId'))
            ORDER BY o.rowid DESC LIMIT 1) AS deciding,
          (SELECT MAX(json_extract(o.body,'$.updatedAt')) FROM records o
            WHERE o.kind='operation' AND json_valid(o.body)
              AND json_extract(o.body,'$.activityId')=json_extract(a.body,'$.id')) AS updatedAt
        FROM records a WHERE a.kind='activity'
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY json_extract(deciding,'$.status') IN ${terminalStatuses}
          ORDER BY json_extract(deciding,'$.updatedAt') DESC, json_extract(body,'$.createdAt') DESC
        ) AS terminalRank FROM summaries WHERE deciding IS NOT NULL
      )
      SELECT body, deciding, updatedAt FROM ranked
        WHERE json_extract(deciding,'$.status') NOT IN ${terminalStatuses} OR terminalRank<=?
        ORDER BY json_extract(body,'$.createdAt') DESC
    `)
      .all(terminalLimit ?? Number.MAX_SAFE_INTEGER)
      .flatMap((row) => {
        if (typeof row.body !== "string") return [];
        const base = Schema.decodeUnknownSync(ActivityBase)(JSON.parse(row.body));
        const activity = deriveActivity(base, readOperation(row.deciding));
        return activity && typeof row.updatedAt === "string"
          ? [{ ...activity, updatedAt: row.updatedAt }]
          : [];
      });
  }
  operations(terminalLimit?: number) {
    return this.db
      .prepare(`SELECT body FROM records WHERE kind='operation' AND json_valid(body)
      AND (json_extract(body,'$.status') NOT IN ${terminalStatuses}
        OR id IN (SELECT id FROM records WHERE kind='operation' AND json_valid(body)
          AND json_extract(body,'$.status') IN ${terminalStatuses}
          ORDER BY json_extract(body,'$.updatedAt') DESC, rowid DESC LIMIT ?))
      ORDER BY rowid DESC`)
      .all(terminalLimit ?? Number.MAX_SAFE_INTEGER)
      .flatMap((row) => readOperation(row.body));
  }
  instances(stoppedLimit: number) {
    return this.db
      .prepare(`SELECT body FROM records WHERE kind='instance'
      AND (json_extract(body,'$.status')!='stopped'
        OR id IN (SELECT id FROM records WHERE kind='instance'
          AND json_extract(body,'$.status')='stopped'
          ORDER BY COALESCE(json_extract(body,'$.stoppedAt'),json_extract(body,'$.createdAt')) DESC,
            rowid DESC LIMIT ?)) ORDER BY rowid DESC`)
      .all(stoppedLimit)
      .map((row) => Schema.decodeUnknownSync(Instance)(JSON.parse(String(row.body))));
  }
  updateActivity(id: string, update: (base: ActivityBase) => ActivityBase) {
    const current = this.get("activity", id);
    if (current !== undefined)
      this.put("activity", id, update(Schema.decodeUnknownSync(ActivityBase)(current)));
  }
  snapshot(limits = this.snapshotLimits): Snapshot {
    const machine = Schema.decodeUnknownSync(Machine)(this.get("machine", "self"));
    return {
      revision: `${this.startId}:${this.changes}`,
      preparationBusy:
        this.list("provision").length > 0 ||
        [
          ...this.list("preparation"),
          ...this.list("macInstallation"),
          ...this.list("windowsInstallation"),
        ].some((value) => {
          const { phase } = Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.String }))(
            value,
          );
          return ["downloading", "booting", "installing", "setup_running"].includes(phase);
        }),
      protocolVersion: 1,
      machine,
      environments: this.list("environment").map((value) =>
        Schema.decodeUnknownSync(Environment)(value),
      ),
      instances: this.instances(limits.stoppedInstances),
      operations: this.operations(limits.operations),
      activities: this.activitySummaries(limits.activities),
    };
  }
  accept(
    key: string,
    fingerprint: string,
    command: string,
    link?: ActivityLink,
    operationId: string = randomUUID(),
  ): { operation: Operation; fresh: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT fingerprint,operation_id FROM requests WHERE key=?")
        .get(key);
      if (old) {
        const record = this.get("operation", String(old.operation_id));
        if (record === undefined)
          throw new VectisError(
            "operation_expired",
            "This request key was used for an operation that has been pruned.",
            "Use a new request key.",
          );
        if (old.fingerprint !== fingerprint)
          throw new VectisError(
            "idempotency_conflict",
            "This request key was used for a different command.",
            "Use the original command or a new request key.",
          );
        const operation = decodeOperation(record);
        this.db.exec("COMMIT");
        return { operation, fresh: false };
      }
      const now = new Date().toISOString();
      const operation: Operation = {
        id: operationId,
        ...(link ? { activityId: link.activityId } : {}),
        key,
        command,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
        message: "Accepted.",
      };
      this.db
        .prepare("INSERT INTO records(kind,id,body) VALUES('operation',?,?)")
        .run(operation.id, JSON.stringify(operation));
      this.touch();
      this.db.prepare("INSERT INTO requests VALUES(?,?,?)").run(key, fingerprint, operation.id);
      if (link?.create && !this.get("activity", link.activityId))
        this.put("activity", link.activityId, link.create);
      this.db.exec("COMMIT");
      return { operation, fresh: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  update(operation: Operation, patch: Partial<Operation>): Operation {
    const current = this.get("operation", operation.id);
    const next = redactOperation({
      ...(current === undefined ? operation : Schema.decodeUnknownSync(Operation)(current)),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    if (current !== undefined) this.put("operation", next.id, next);
    return next;
  }
  recover() {
    for (const operation of this.snapshot().operations)
      if (operation.status === "accepted" || operation.status === "running")
        this.update(operation, {
          status: "action_required",
          message:
            "The service restarted before completion was confirmed. Inspect the operation before retrying.",
          ...(operation.command === "runner.run"
            ? {
                result: {
                  ...(typeof operation.result === "object" && operation.result !== null
                    ? operation.result
                    : {}),
                  code: "runner_recovery_pending",
                  nextStep:
                    "Vectis retries recovery automatically while connected. Confirm the owned VM stopped before manually running vectis runner reconcile with this operation ID.",
                },
              }
            : {}),
        });
    for (const instance of this.snapshot().instances)
      if (instance.status === "starting" || instance.status === "running")
        this.put("instance", instance.id, { ...instance, status: "interrupted" });
  }
}
