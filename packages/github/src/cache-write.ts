import { Schema } from "effect";
import { GitHubApiError } from "./api-request.js";
import { GitHubId } from "../../protocol/src/repository-access.js";

const Repository = Schema.Struct({ id: GitHubId, default_branch: Schema.NonEmptyString });
const Run = Schema.Struct({
  id: GitHubId,
  run_attempt: GitHubId,
  event: Schema.String,
  head_branch: Schema.String,
  repository: Schema.Struct({ id: GitHubId }),
  head_repository: Schema.Struct({ id: GitHubId }),
});

export async function readCacheWrite(
  read: (path: string) => Promise<unknown>,
  repositoryId: number,
  runId: number,
  runAttempt?: number,
) {
  try {
    const [repositoryValue, runValue] = await Promise.all([
      read(""),
      read(`/actions/runs/${runId}`),
    ]);
    const repository = Schema.decodeUnknownSync(Repository)(repositoryValue);
    const run = Schema.decodeUnknownSync(Run)(runValue);
    if (repository.id !== repositoryId || run.repository.id !== repositoryId)
      return { cacheWrite: false, cacheWriteReason: "repository_mismatch" };
    if (run.id !== runId || (runAttempt !== undefined && run.run_attempt !== runAttempt))
      return { cacheWrite: false, cacheWriteReason: "run_attempt_mismatch" };
    if (run.head_repository.id !== repositoryId)
      return { cacheWrite: false, cacheWriteReason: "fork" };
    if (run.head_branch !== repository.default_branch)
      return { cacheWrite: false, cacheWriteReason: "non_default_branch" };
    if (!["push", "schedule", "workflow_dispatch"].includes(run.event))
      return { cacheWrite: false, cacheWriteReason: "event_not_allowed" };
    return { cacheWrite: true, cacheRun: { runId, runAttempt: run.run_attempt } };
  } catch (error) {
    return {
      cacheWrite: false,
      cacheWriteReason:
        error instanceof GitHubApiError && error.status === 403
          ? "metadata_access_denied"
          : "metadata_unavailable",
    };
  }
}
