import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Schema } from "effect";
import {
  ActivityBase,
  Environment,
  Instance,
  Operation,
  VectisError,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";
import { deriveActivity, type ActivityLink } from "./activities.js";
import { migrateStore } from "./store-migrations.js";

const decodeOperation = Schema.decodeUnknownSync(Operation);
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
  constructor(path: string) {
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
    this.db
      .prepare(
        "INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(body));
    this.touch();
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
    this.touch();
  }
  touch() {
    this.changes++;
  }
  activityMembers(activityId: string): Operation[] {
    return this.db
      .prepare(
        "SELECT body FROM records WHERE kind='operation' AND json_valid(body) AND json_extract(body,'$.activityId')=? ORDER BY rowid",
      )
      .all(activityId)
      .flatMap((row) => readOperation(row.body));
  }
  private activities(operations: readonly Operation[]) {
    const groups = new Map<string, Operation[]>();
    for (const operation of operations) {
      if (operation.activityId === undefined) continue;
      const members = groups.get(operation.activityId);
      if (members) members.push(operation);
      else groups.set(operation.activityId, [operation]);
    }
    return this.list("activity")
      .flatMap((value) => {
        const base = Schema.decodeUnknownSync(ActivityBase)(value);
        // Operations are read newest row first; preparation outcomes follow insertion order.
        const activity = deriveActivity(base, (groups.get(base.id) ?? []).toReversed());
        return activity ? [activity] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  updateActivity(id: string, update: (base: ActivityBase) => ActivityBase) {
    const current = this.get("activity", id);
    if (current !== undefined)
      this.put("activity", id, update(Schema.decodeUnknownSync(ActivityBase)(current)));
  }
  snapshot(): Snapshot {
    const machine = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, name: Schema.String, paused: Schema.Boolean }),
    )(this.get("machine", "self"));
    const operations = this.db
      .prepare("SELECT body FROM records WHERE kind='operation' ORDER BY rowid DESC")
      .all()
      .flatMap((row) => readOperation(row.body));
    return {
      revision: `${this.startId}:${this.changes}`,
      preparationBusy: [
        ...this.list("preparation"),
        ...this.list("macInstallation"),
        ...this.list("windowsInstallation"),
      ].some((value) => {
        const { phase } = Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.String }))(value);
        return ["downloading", "booting", "installing", "setup_running"].includes(phase);
      }),
      protocolVersion: 1,
      machine,
      environments: this.list("environment").map((value) =>
        Schema.decodeUnknownSync(Environment)(value),
      ),
      instances: this.list("instance").map((value) => Schema.decodeUnknownSync(Instance)(value)),
      operations,
      activities: this.activities(operations),
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
        const operation = Schema.decodeUnknownSync(Operation)(record);
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
    const next = {
      ...(current === undefined ? operation : Schema.decodeUnknownSync(Operation)(current)),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
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
        });
    for (const instance of this.snapshot().instances)
      if (instance.status === "running")
        this.put("instance", instance.id, { ...instance, status: "interrupted" });
  }
}
