import { Schema } from "effect";
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
    const cacheWrite =
      repository.id === repositoryId &&
      run.id === runId &&
      run.repository.id === repositoryId &&
      run.head_repository.id === repositoryId &&
      run.head_branch === repository.default_branch &&
      (runAttempt === undefined || run.run_attempt === runAttempt) &&
      ["push", "schedule", "workflow_dispatch"].includes(run.event);
    return {
      cacheWrite,
      ...(cacheWrite ? { cacheRun: { runId, runAttempt: run.run_attempt } } : {}),
    };
  } catch {
    return { cacheWrite: false };
  }
}
