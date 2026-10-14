import { Schema } from "effect";
import { GitHubId } from "../../protocol/src/repository-access.js";
import type { GitHubJob } from "./job.js";

const Run = Schema.Struct({
  id: GitHubId,
  run_attempt: GitHubId,
  repository: Schema.Struct({ id: GitHubId }),
  actor: Schema.Struct({ id: GitHubId }),
  triggering_actor: Schema.Struct({ id: GitHubId }),
});

export async function readRunActors(
  read: (path: string) => Promise<unknown>,
  repositoryId: number,
  runId: number,
) {
  const run = Schema.decodeUnknownSync(Run)(await read(`/actions/runs/${runId}`));
  if (run.id !== runId || run.repository.id !== repositoryId)
    throw new Error("GitHub returned a different workflow run or repository.");
  return {
    run_attempt: run.run_attempt,
    actor_id: run.actor.id,
    triggering_actor_id: run.triggering_actor.id,
  };
}

export function withRunActors(
  job: GitHubJob,
  actors: Awaited<ReturnType<typeof readRunActors>>,
): GitHubJob {
  if (job.run_attempt !== undefined && job.run_attempt !== actors.run_attempt)
    throw new Error("GitHub returned actors from a different run attempt.");
  return { ...job, ...actors };
}
