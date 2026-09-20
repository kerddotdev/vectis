import { randomUUID } from "node:crypto";
import { ServiceLog } from "../../protocol/src/logs.js";
import { Snapshot, Operation as OperationSchema } from "../../protocol/src/index.js";
import { LocalQuery } from "../../protocol/src/controller.js";
import { Diagnostics } from "../../protocol/src/diagnostics.js";
import { StorageReport } from "../../protocol/src/storage.js";
import { Jobs } from "../../protocol/src/jobs.js";
import { GitHubAccounts, MachineRepositories } from "../../protocol/src/repositories.js";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import {
  Identifier,
  VectisError,
  decodeCommand,
  type Command,
  type Operation,
} from "../../protocol/src/index.js";
import { ControllerClient } from "./controller.js";
import { activitiesOf, activityOf } from "./index.js";

const Record = Schema.Struct({
  _id: Identifier,
  machineId: Identifier,
  key: Schema.String,
  commandJson: Schema.String,
  phase: Schema.Literals([
    "accepted",
    "claimed",
    "running",
    "succeeded",
    "failed",
    "action_required",
    "cancelled",
  ]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  resultJson: Schema.optional(Schema.String),
});
const Summary = Schema.Struct({
  message: Schema.String,
  operationId: Schema.optional(Identifier),
  resultAvailableLocally: Schema.Boolean,
});

export class RemoteClient {
  constructor(
    readonly controller: ControllerClient,
    readonly machineId: string,
  ) {
    Schema.decodeUnknownSync(Identifier)(machineId);
  }
  async operation(id: string, signal?: AbortSignal): Promise<Operation> {
    if (/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) return this.localOperation(id, signal);
    const remote = Schema.decodeUnknownSync(Record)(
      await this.controller.request({ type: "operation.get", id }, signal),
    );
    if (remote.machineId !== this.machineId)
      throw new VectisError("operation_missing", "This operation belongs to another machine.");
    const summary = remote.resultJson
      ? Schema.decodeUnknownSync(Summary)(JSON.parse(remote.resultJson))
      : undefined;
    let result: unknown = {
      remotePhase: remote.phase,
      ...(summary
        ? {
            localOperationId: summary.operationId,
            resultAvailableLocally: summary.resultAvailableLocally,
          }
        : {}),
    };
    if (summary?.operationId && summary.resultAvailableLocally) {
      try {
        result = (await this.localOperation(summary.operationId, signal)).result;
      } catch (error) {
        if (
          !(
            error instanceof VectisError &&
            ["machine_offline", "query_expired"].includes(error.code)
          )
        )
          throw error;
      }
    }
    return {
      id: remote._id,
      key: remote.key,
      command: decodeCommand(JSON.parse(remote.commandJson)).type,
      status: remote.phase === "claimed" ? "accepted" : remote.phase,
      createdAt: new Date(remote.createdAt).toISOString(),
      updatedAt: new Date(remote.updatedAt).toISOString(),
      message:
        summary?.message ??
        (remote.phase === "accepted"
          ? "Queued for the selected machine; execution has not started."
          : remote.phase === "claimed"
            ? "The selected machine acknowledged the request."
            : remote.phase === "cancelled"
              ? "Cancelled before execution."
              : "Running on the selected machine."),
      ...(result === undefined ? {} : { result }),
    };
  }
  async submit(command: Command, key: string, signal?: AbortSignal) {
    if (command.type === "operation.cancel" && !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(command.id)) {
      await this.operation(command.id, signal);
      await this.controller.request({ type: "operation.cancel", id: command.id }, signal);
      return this.operation(command.id, signal);
    }
    const result = Schema.decodeUnknownSync(Schema.Struct({ operationId: Identifier }))(
      await this.controller.request(
        { type: "operation.submit", machineId: this.machineId, key, command },
        signal,
      ),
    );
    return this.operation(result.operationId, signal);
  }
  async settle(command: Command, key: string, signal?: AbortSignal): Promise<Operation> {
    const operation = await this.submit(command, key, signal);
    if (operation.status !== "accepted" && operation.status !== "running") return operation;
    return this.wait(operation.id, signal);
  }
  async wait(id: string, signal: AbortSignal = AbortSignal.timeout(120000)) {
    try {
      while (!signal.aborted) {
        const operation = await this.operation(id, signal);
        if (operation.status !== "accepted" && operation.status !== "running") return operation;
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    throw new VectisError(
      "wait_cancelled",
      "Waiting stopped; the remote operation may still be running.",
      "Query its operation ID before retrying the command.",
    );
  }
  private async inspect(query: LocalQuery, signal: AbortSignal = AbortSignal.timeout(45000)) {
    try {
      const accepted = Schema.decodeUnknownSync(Schema.Struct({ queryId: Identifier }))(
        await this.controller.request(
          { type: "query.submit", machineId: this.machineId, key: randomUUID(), query },
          signal,
        ),
      );
      while (!signal.aborted) {
        const response = Schema.decodeUnknownSync(
          Schema.Struct({ pending: Schema.Boolean, responseJson: Schema.NullOr(Schema.String) }),
        )(await this.controller.request({ type: "query.get", id: accepted.queryId }, signal));
        if (!response.pending && response.responseJson) {
          const result = Schema.decodeUnknownSync(
            Schema.Union([
              Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
              Schema.Struct({
                ok: Schema.Literal(false),
                code: Schema.String,
                message: Schema.String,
                nextStep: Schema.String,
              }),
            ]),
          )(JSON.parse(response.responseJson));
          if (!result.ok) throw new VectisError(result.code, result.message, result.nextStep);
          return result.result;
        }
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    throw new VectisError("remote_query_timeout", "The selected machine did not answer in time.");
  }
  async status(signal?: AbortSignal) {
    return Schema.decodeUnknownSync(Snapshot)(await this.inspect({ name: "status" }, signal));
  }
  async activities(signal?: AbortSignal) {
    return activitiesOf(await this.status(signal));
  }
  async activity(id: string, signal?: AbortSignal) {
    return activityOf(await this.status(signal), id);
  }
  async storage() {
    return Schema.decodeUnknownSync(StorageReport)(await this.inspect({ name: "storage" }));
  }
  async doctor() {
    return Schema.decodeUnknownSync(Diagnostics)(await this.inspect({ name: "doctor" }));
  }
  async jobs(bindingId: string) {
    return Schema.decodeUnknownSync(Jobs)(await this.inspect({ name: "jobs", bindingId }));
  }
  async githubAccounts() {
    return Schema.decodeUnknownSync(GitHubAccounts)(
      await this.inspect({ name: "github.accounts" }),
    );
  }
  async repositories() {
    return Schema.decodeUnknownSync(MachineRepositories)(
      await this.inspect({ name: "repositories" }),
    );
  }
  async capabilities() {
    return this.inspect({ name: "capabilities" });
  }
  async logs(lines?: number) {
    return Schema.decodeUnknownSync(ServiceLog)(
      await this.inspect(lines === undefined ? { name: "logs" } : { name: "logs", lines }),
    );
  }
  async localOperation(id: string, signal?: AbortSignal) {
    return Schema.decodeUnknownSync(OperationSchema)(
      await this.inspect({ name: "operation", id }, signal),
    );
  }
  async shutdown(): Promise<never> {
    throw new VectisError(
      "local_service_required",
      "Service shutdown must be requested on its host.",
    );
  }
}
