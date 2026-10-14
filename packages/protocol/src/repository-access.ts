import { Schema } from "effect";

export const GitHubId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const RepositoryActors = Schema.Union([
  Schema.Literal("any"),
  Schema.Struct({ ids: Schema.Array(GitHubId).check(Schema.isMaxLength(100)) }),
]);
export const RepositoryAccess = Schema.Struct({
  actors: RepositoryActors,
  approval: Schema.Literals(["automatic", "required"]),
});
export type RepositoryAccess = typeof RepositoryAccess.Type;
export const RunnerAccess = Schema.Struct({
  repositoryId: GitHubId,
  ...RepositoryAccess.fields,
  approvedRun: Schema.optional(Schema.Struct({ runId: GitHubId, runAttempt: GitHubId })),
});
export type RunnerAccess = typeof RunnerAccess.Type;
