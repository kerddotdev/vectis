import { Schema } from "effect";
import { Command, Identifier } from "./index.js";
import { LogRequest } from "./logs.js";

export const ControllerApproval = Schema.Struct({
  deploymentUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.convex\.cloud$/)),
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  credentialDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  expiresAt: Schema.Number,
});
export type ControllerApproval = typeof ControllerApproval.Type;

export const LocalQuery = Schema.Union([
  Schema.Struct({
    name: Schema.Literals([
      "status",
      "storage",
      "doctor",
      "repositories",
      "github.accounts",
      "capabilities",
    ]),
  }),
  Schema.Struct({ name: Schema.Literal("jobs"), bindingId: Identifier }),
  Schema.Struct({ name: Schema.Literal("operation"), id: Identifier }),
  Schema.Struct({ name: Schema.Literal("logs"), ...LogRequest.fields }),
]);
export type LocalQuery = typeof LocalQuery.Type;
export const ControllerRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("operation.cancel"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("query.submit"),
    machineId: Identifier,
    key: Identifier,
    query: LocalQuery,
  }),
  Schema.Struct({ type: Schema.Literal("query.get"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("controller.revoke") }),
  Schema.Struct({ type: Schema.Literal("machines.list") }),
  Schema.Struct({
    type: Schema.Literal("operation.submit"),
    machineId: Identifier,
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    command: Command,
  }),
  Schema.Struct({ type: Schema.Literal("operation.get"), id: Identifier }),
]);
export type ControllerRequest = typeof ControllerRequest.Type;
