import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Schema } from "effect";
import {
  Environment,
  Instance,
  Operation,
  VectisError,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL);`);
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
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  snapshot(): Snapshot {
    const machine = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, name: Schema.String, paused: Schema.Boolean }),
    )(this.get("machine", "self"));
    return {
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
      operations: this.list("operation").map((value) => Schema.decodeUnknownSync(Operation)(value)),
    };
  }
  accept(
    key: string,
    fingerprint: string,
    command: string,
  ): { operation: Operation; fresh: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT fingerprint,operation_id FROM requests WHERE key=?")
        .get(key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new VectisError(
            "idempotency_conflict",
            "This request key was used for a different command.",
            "Use the original command or a new request key.",
          );
        const operation = Schema.decodeUnknownSync(Operation)(
          this.get("operation", String(old.operation_id)),
        );
        this.db.exec("COMMIT");
        return { operation, fresh: false };
      }
      const now = new Date().toISOString();
      const operation: Operation = {
        id: randomUUID(),
        key,
        command,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
        message: "Accepted.",
      };
      this.put("operation", operation.id, operation);
      this.db.prepare("INSERT INTO requests VALUES(?,?,?)").run(key, fingerprint, operation.id);
      this.db.exec("COMMIT");
      return { operation, fresh: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  update(operation: Operation, patch: Partial<Operation>): Operation {
    const next = { ...operation, ...patch, updatedAt: new Date().toISOString() };
    this.put("operation", next.id, next);
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
