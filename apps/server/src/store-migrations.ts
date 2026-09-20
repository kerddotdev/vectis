import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  commandActivity,
  Identifier,
  Operation,
  VectisError,
  type ActivityBase,
} from "../../../packages/protocol/src/index.js";
import { RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { preparationOS } from "./activities.js";

export function migrateStore(db: DatabaseSync) {
  let skipped = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number") throw new Error("Cannot read the store schema version.");
    if (version < 1) {
      const operations = db
        .prepare("SELECT body FROM records WHERE kind='operation' ORDER BY rowid")
        .all()
        .flatMap((row) => {
          try {
            const raw: unknown = JSON.parse(String(row.body));
            if (Schema.is(Operation)(raw) && raw.command.length > 0) return [raw];
          } catch {
            // Preserve unreadable history in place without blocking recovery of valid work.
          }
          skipped++;
          return [];
        });
      const runners = new Map(
        operations
          .filter((operation) => operation.command === "runner.run")
          .map((op) => [op.id, op]),
      );
      const classifications = new Map(Object.entries(commandActivity));
      const setupResult = Schema.Struct({ setupId: Identifier });
      const reconcileResult = Schema.Struct({ operationId: Identifier });
      const insertBase = db.prepare(
        "INSERT INTO records(kind,id,body) VALUES('activity',?,?) ON CONFLICT(kind,id) DO NOTHING",
      );
      const writeOperation = db.prepare(
        "UPDATE records SET body=? WHERE kind='operation' AND id=?",
      );
      for (const operation of operations) {
        const parentId = /^(.+):(start|stop|cancel-start)$/.exec(operation.key)?.[1];
        // Internal cleanup commands are settings on their own, but still belong to their runner.
        const parent = parentId ? runners.get(parentId) : undefined;
        const runnerCleanup =
          parent &&
          ((operation.command === "instance.stop" && operation.key.endsWith(":stop")) ||
            (operation.command === "operation.cancel" && operation.key.endsWith(":cancel-start")));
        if (classifications.get(operation.command) === "setting" && !runnerCleanup) continue;
        if (operation.command === "job.scan" && operation.key.startsWith("remote:")) continue;
        const os = preparationOS(operation.command);
        if (!os && operation.command !== "runner.run" && parent) {
          writeOperation.run(JSON.stringify({ ...operation, activityId: parent.id }), operation.id);
          continue;
        }
        if (
          operation.command === "runner.reconcile" &&
          Schema.is(reconcileResult)(operation.result) &&
          runners.has(operation.result.operationId)
        ) {
          writeOperation.run(
            JSON.stringify({ ...operation, activityId: operation.result.operationId }),
            operation.id,
          );
          continue;
        }
        const activityId =
          os && Schema.is(setupResult)(operation.result) ? operation.result.setupId : operation.id;
        const subject: ActivityBase["subject"] = os
          ? { type: "preparation", setupId: activityId, os }
          : operation.command === "runner.run"
            ? { type: "runner" }
            : { type: "command", command: operation.command };
        const progress =
          subject.type === "runner" && Schema.is(RunnerProgress)(operation.result)
            ? operation.result
            : undefined;
        const base: ActivityBase = {
          id: activityId,
          kind: subject.type === "runner" ? "github" : "vectis",
          subject,
          rootOperationId: operation.id,
          createdAt: operation.createdAt,
          ...(progress
            ? { bindingId: progress.bindingId, environmentId: progress.environmentId }
            : {}),
        };
        insertBase.run(activityId, JSON.stringify(base));
        writeOperation.run(JSON.stringify({ ...operation, activityId }), operation.id);
      }
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw new VectisError(
      "store_migration_failed",
      `Activity migration failed: ${error instanceof Error ? error.message : String(error)}`,
      "The migration was rolled back. Resolve the store error before starting the service again.",
    );
  }
  if (skipped > 0)
    console.warn(`Activity migration skipped ${skipped} unreadable history records.`);
}
