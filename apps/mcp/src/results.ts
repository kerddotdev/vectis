import { Schema } from "effect";
import {
  Activity,
  ApiError,
  Instance,
  Operation,
  Snapshot,
} from "../../../packages/protocol/src/index.js";
import { ControllerResponses } from "../../../packages/protocol/src/cloud.js";

export function outputSchema(result: Schema.Top) {
  const { schema, definitions } = Schema.toJsonSchemaDocument(
    Schema.Union([Schema.Struct({ result }), Schema.Struct({ error: ApiError })]),
  );
  // The SDK also validates structuredContent on isError responses.
  return { ...schema, type: "object" as const, $defs: definitions };
}

export const MachineList = ControllerResponses["machines.list"];

function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byId(a: { id: string }, b: { id: string }) {
  return compareStrings(a.id, b.id);
}

const {
  revision,
  version,
  protocolVersion,
  machine,
  cloud,
  runnerCapacity,
  scaleSets,
  preparationBusy,
  environments,
} = Snapshot.fields;
const { id, name, os, state, cpu, memoryMiB, network } = environments.value.fields;
const { environmentId, status, createdAt } = Instance.fields;
const { activityId, command, updatedAt, message } = Operation.fields;
const { kind, rootOperationId } = Activity.fields;
const Counts = Schema.Struct({
  total: Schema.Int,
  byStatus: Schema.Record(Schema.String, Schema.Int),
});
export const StatusResult = Schema.Struct({
  revision,
  version,
  protocolVersion,
  machine,
  cloud,
  runnerCapacity,
  scaleSets,
  preparationBusy,
  environments: Schema.Array(Schema.Struct({ id, name, os, state, cpu, memoryMiB, network })),
  instances: Schema.Array(Schema.Struct({ id, environmentId, status, createdAt })),
  counts: Schema.Struct({
    scope: Schema.Literal("bounded status window"),
    operations: Counts,
    activities: Counts,
    instances: Counts,
  }),
  operations: Schema.Array(
    Schema.Struct({
      id,
      activityId,
      command,
      status: Operation.fields.status,
      updatedAt,
      message,
    }),
  ),
  activities: Schema.Array(
    Schema.Struct({
      id,
      kind,
      status: Activity.fields.status,
      updatedAt,
      rootOperationId,
      message,
    }),
  ),
  details: Schema.String,
});

const statusHistoryLimit = 20;

export function compactStatus(snapshot: Snapshot): typeof StatusResult.Type {
  const activities = snapshot.activities ?? [];
  const counts = (items: readonly { status: string }[]) => {
    const statuses: Record<string, number> = {};
    for (const item of items) statuses[item.status] = (statuses[item.status] ?? 0) + 1;
    return {
      total: items.length,
      byStatus: Object.fromEntries(
        Object.entries(statuses).sort(([a], [b]) => compareStrings(a, b)),
      ),
    };
  };
  return {
    protocolVersion: snapshot.protocolVersion,
    version: snapshot.version,
    revision: snapshot.revision,
    machine: snapshot.machine,
    cloud: snapshot.cloud,
    runnerCapacity: snapshot.runnerCapacity && {
      ...snapshot.runnerCapacity,
      environments: snapshot.runnerCapacity.environments?.toSorted((a, b) =>
        compareStrings(a.environmentId, b.environmentId),
      ),
    },
    ...(snapshot.scaleSets === undefined
      ? {}
      : {
          scaleSets: snapshot.scaleSets.toSorted((a, b) =>
            compareStrings(a.bindingId, b.bindingId),
          ),
        }),
    preparationBusy: snapshot.preparationBusy,
    environments: snapshot.environments
      .toSorted(byId)
      .map(({ id, name, os, state, cpu, memoryMiB, network }) => ({
        id,
        name,
        os,
        state,
        cpu,
        memoryMiB,
        network,
      })),
    instances: snapshot.instances
      .filter((instance) => instance.status !== "stopped")
      .sort(byId)
      .map(({ id, environmentId, status, createdAt }) => ({
        id,
        environmentId,
        status,
        createdAt,
      })),
    counts: {
      scope: "bounded status window",
      operations: counts(snapshot.operations),
      activities: counts(activities),
      instances: counts(snapshot.instances),
    },
    operations: snapshot.operations
      .toSorted((a, b) => compareStrings(b.updatedAt, a.updatedAt) || byId(a, b))
      .slice(0, statusHistoryLimit)
      .map(({ id, activityId, command, status, updatedAt, message }) => ({
        id,
        activityId,
        command,
        status,
        updatedAt,
        message: message.slice(0, 300),
      })),
    activities: activities
      .toSorted((a, b) => compareStrings(b.updatedAt, a.updatedAt) || byId(a, b))
      .slice(0, statusHistoryLimit)
      .map(({ id, kind, status, updatedAt, rootOperationId, message }) => ({
        id,
        kind,
        status,
        updatedAt,
        rootOperationId,
        message: message.slice(0, 300),
      })),
    details:
      "Use vectis_activities to list recent and unfinished activities, vectis_activity for an activity's steps, and vectis_operation for full operation results.",
  };
}
