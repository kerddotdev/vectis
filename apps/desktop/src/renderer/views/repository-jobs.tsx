import { useState } from "react";
import { Schema } from "effect";
import { RefreshCwIcon } from "lucide-react";
import { Jobs } from "../../../../../packages/protocol/src/jobs.js";
import { Mono, Notice } from "@/components/layout";
import { JobStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStateApi } from "@/state";

export function RepositoryJobs({ bindingId }: { bindingId: string }) {
  const { perform, submit } = useStateApi();
  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState("");
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setPending(true);
    setError("");
    try {
      const value = await perform("jobs", bindingId);
      if (value !== undefined) setJobs(Schema.decodeUnknownSync(Jobs)(value));
    } catch {
      setError("GitHub job records could not be read.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => void refresh()}>
          <RefreshCwIcon />
          {pending ? "Reading jobs" : "Refresh GitHub jobs"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void submit({ type: "job.scan", bindingId }).then((value) =>
              setRequested(value !== undefined),
            )
          }
        >
          Discover missing jobs
        </Button>
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const id = Number(jobId);
            if (!Number.isSafeInteger(id) || id <= 0) {
              setError("Enter a positive GitHub job ID.");
              return;
            }
            setError("");
            void submit({ type: "job.refresh", bindingId, jobId: id }).then((value) =>
              setRequested(value !== undefined),
            );
          }}
        >
          <Input
            aria-label="GitHub job ID"
            placeholder="GitHub job ID"
            className="h-7 w-36"
            value={jobId}
            inputMode="numeric"
            required
            onChange={(event) => setJobId(event.target.value)}
          />
          <Button type="submit" variant="ghost" size="sm">
            Recover job
          </Button>
        </form>
      </div>
      {requested && (
        <Notice>
          Refresh requested. Follow its operation in Overview, then refresh this list.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {jobs?.length === 0 && (
        <p className="text-muted-foreground">
          No GitHub jobs have been observed for this repository yet.
        </p>
      )}
      {jobs && jobs.length > 0 && (
        <div className="flex flex-col">
          <p className="pb-2 text-xs text-muted-foreground">
            Latest observed GitHub results. Runner cleanup is tracked separately in Overview.
          </p>
          {jobs.map((job) => (
            <div
              key={job.jobId}
              className="flex items-center gap-3 border-t border-border py-2 first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              <Mono>
                run {job.runId} · job {job.jobId}
              </Mono>
              <JobStatus status={job.status} conclusion={job.conclusion} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
