import { Schema } from "effect";
import { Identifier } from "./identifier.js";

export const ReadinessTarget = Schema.Struct({
  area: Schema.Literals([
    "connections",
    "environments",
    "repositories",
    "diagnostics",
    "settings",
    "github",
  ]),
  section: Schema.optional(Schema.String),
});
export type ReadinessTarget = typeof ReadinessTarget.Type;
export const ReadinessCheck = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literals(["ok", "attention", "blocked", "unknown"]),
  code: Schema.optional(Schema.NonEmptyString),
  message: Schema.String,
  nextStep: Schema.optional(Schema.String),
  target: Schema.optional(ReadinessTarget),
});
export type ReadinessCheck = typeof ReadinessCheck.Type;
export const RepositoryReadinessInput = Schema.Union([
  Schema.Struct({
    repositoryName: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),
    ),
    environmentId: Schema.optionalKey(Identifier),
  }),
  Schema.Struct({ bindingId: Identifier }),
]);
export type RepositoryReadinessInput = typeof RepositoryReadinessInput.Type;
export const RepositoryReadiness = Schema.Struct({
  checks: Schema.Array(ReadinessCheck),
  ready: Schema.Boolean,
});
export type RepositoryReadiness = typeof RepositoryReadiness.Type;
export const CloudRepositoryReadiness = Schema.Struct({
  checks: Schema.Array(ReadinessCheck),
  environmentId: Schema.optionalKey(Identifier),
  cacheVolumeEnabled: Schema.optionalKey(Schema.Boolean),
});
export type CloudRepositoryReadiness = typeof CloudRepositoryReadiness.Type;
