import { Schema } from "effect";
import { GitHubJob } from "./job.js";

const RunsPage = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(Schema.Struct({ id: Schema.Int })),
});
const JobsPage = Schema.Struct({ total_count: Schema.Int, jobs: Schema.Array(GitHubJob) });

export async function scanRepositoryJobs(
  read: (path: string) => Promise<unknown>,
  save: (jobs: readonly GitHubJob[]) => Promise<void>,
  knownRunIds: readonly number[],
  requestLimit = 80,
) {
  let requests = 0;
  let jobs = 0;
  let runs = 0;
  let complete = true;
  const deadline = Date.now() + 120000;
  const available = () => requests < requestLimit && Date.now() < deadline;
  const runIds = new Set(knownRunIds);
  for (const status of ["queued", "in_progress"]) {
    let page = 1;
    while (true) {
      if (!available()) {
        complete = false;
        break;
      }
      requests++;
      const result = Schema.decodeUnknownSync(RunsPage)(
        await read(`/actions/runs?status=${status}&per_page=50&page=${page}`),
      );
      for (const run of result.workflow_runs) runIds.add(run.id);
      if (page * 50 >= result.total_count) break;
      if (!result.workflow_runs.length || page >= 20) {
        complete = false;
        break;
      }
      page++;
    }
  }
  for (const runId of runIds) {
    let page = 1;
    while (true) {
      if (!available()) return { runs, jobs, complete: false };
      requests++;
      const result = Schema.decodeUnknownSync(JobsPage)(
        await read(`/actions/runs/${runId}/jobs?filter=latest&per_page=50&page=${page}`),
      );
      if (result.jobs.some((job) => job.run_id !== runId))
        throw new Error("GitHub returned a job from a different workflow run.");
      await save(result.jobs);
      jobs += result.jobs.length;
      if (page * 50 >= result.total_count) {
        runs++;
        break;
      }
      if (!result.jobs.length) {
        complete = false;
        break;
      }
      page++;
    }
  }
  return { runs, jobs, complete };
}
