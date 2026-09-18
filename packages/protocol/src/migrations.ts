import { Schema } from "effect";

export const RepositoryMigration = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  baseCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.Literals(["100644", "100755"]),
      before: Schema.String,
      after: Schema.String,
      changed: Schema.Boolean,
      findings: Schema.Array(Schema.Struct({ job: Schema.String, reason: Schema.String })),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type RepositoryMigration = typeof RepositoryMigration.Type;
export const MigrationAnalysis = Schema.Struct({
  previewId: Schema.String,
  verified: Schema.Boolean,
  ...RepositoryMigration.fields,
});
export type MigrationAnalysis = typeof MigrationAnalysis.Type;
export const MigrationPublication = Schema.Struct({
  status: Schema.Literals(["created", "existing"]),
  state: Schema.Literals(["open", "closed"]),
  number: Schema.Int,
  url: Schema.String,
});
export type MigrationPublication = typeof MigrationPublication.Type;
