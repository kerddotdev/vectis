import { Schema } from "effect";
import { Identifier } from "./identifier.js";

const GitHubId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Workflow = Schema.Union([
  GitHubId,
  Schema.String.check(
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/),
  ),
]);
const Ref = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.makeFilter(
    (value) =>
      !value.startsWith("-") &&
      value !== "@" &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) > 32 &&
          character.charCodeAt(0) !== 127 &&
          !"~^:?*[\\".includes(character),
      ) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
  ),
);
const Inputs = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/)),
  Schema.String.check(Schema.isMaxLength(65535)),
).check(
  Schema.makeFilter(
    (inputs) =>
      Object.keys(inputs).length <= 25 &&
      new TextEncoder().encode(JSON.stringify(inputs)).length <= 65535,
  ),
);
export const RerunFailed = Schema.Struct({
  type: Schema.Literal("run.rerun-failed"),
  bindingId: Identifier,
  runId: GitHubId,
});
export const CancelRun = Schema.Struct({
  type: Schema.Literal("run.cancel"),
  bindingId: Identifier,
  runId: GitHubId,
});
export const DispatchWorkflow = Schema.Struct({
  type: Schema.Literal("workflow.dispatch"),
  bindingId: Identifier,
  workflow: Workflow,
  ref: Ref,
  inputs: Schema.optionalKey(Inputs),
}).check(
  Schema.makeFilter((command) => new TextEncoder().encode(JSON.stringify(command)).length <= 65535),
);
export const RunControlCommand = Schema.Union([RerunFailed, CancelRun, DispatchWorkflow]);
export type RunControlCommand = typeof RunControlCommand.Type;

const RunDetails = {
  runId: Schema.optionalKey(GitHubId),
  runAttempt: Schema.optionalKey(GitHubId),
  htmlUrl: Schema.optionalKey(Schema.String),
};
export const RunControlOutcome = Schema.Union([
  Schema.Struct({ state: Schema.Literal("accepted"), message: Schema.String, ...RunDetails }),
  Schema.Struct({
    state: Schema.Literal("uncertain"),
    code: Schema.Literal("run_command_unconfirmed"),
    message: Schema.String,
    nextStep: Schema.String,
    ...RunDetails,
  }),
  Schema.Struct({
    state: Schema.Literal("rejected"),
    code: Schema.String,
    message: Schema.String,
    nextStep: Schema.String,
  }),
]);
export type RunControlOutcome = typeof RunControlOutcome.Type;
export interface RunControlBroker {
  controlRun(
    command: RunControlCommand,
    key: string,
    signal: AbortSignal,
  ): Promise<RunControlOutcome>;
}
