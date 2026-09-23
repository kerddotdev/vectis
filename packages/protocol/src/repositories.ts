import { Schema } from "effect";
import { Identifier } from "./identifier.js";
export const MachineRepositories = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    repositoryId: Schema.Int,
    repositoryName: Schema.NonEmptyString,
    environmentId: Identifier,
    runsOn: Schema.optional(Schema.String),
    automatic: Schema.optional(Schema.Boolean),
  }),
);
export type MachineRepositories = typeof MachineRepositories.Type;

export const GitHubAccounts = Schema.Array(
  Schema.Struct({ id: Identifier, githubId: Schema.Int, login: Schema.NonEmptyString }),
);
export type GitHubAccounts = typeof GitHubAccounts.Type;
export const RepositoryConnection = Schema.Struct({
  repositoryOwner: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]+$/))),
  accountId: Identifier,
  repositoryName: Schema.NonEmptyString,
  environmentId: Identifier,
});
export type RepositoryConnection = typeof RepositoryConnection.Type;
