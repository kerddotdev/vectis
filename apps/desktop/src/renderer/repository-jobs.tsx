import { useState } from "react";
import { Schema } from "effect";
import { Jobs } from "../../../../packages/protocol/src/jobs.js";
import { useStateApi } from "./state.js";

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
    <div>
      <button className="secondary" disabled={pending} onClick={() => void refresh()}>
        {pending ? "Reading jobs" : "Refresh GitHub jobs"}
      </button>
      <form
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
        <label>
          GitHub job ID{" "}
          <input
            value={jobId}
            inputMode="numeric"
            required
            onChange={(event) => setJobId(event.target.value)}
          />
        </label>
        <button type="submit">Recover job from GitHub</button>
      </form>
      {requested && (
        <p role="status">
          Refresh requested. Follow its operation in Overview, then refresh this list.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {jobs?.length === 0 && <p>No GitHub jobs have been observed for this repository yet.</p>}
      {jobs && jobs.length > 0 && (
        <p>Latest observed GitHub results. Runner cleanup is tracked separately in Overview.</p>
      )}
      {jobs?.map((job) => (
        <div className="record" key={job.jobId}>
          <div>
            <strong>{job.name}</strong>
            <p>
              Run {job.runId} / job {job.jobId}
            </p>
          </div>
          <span className="status">{job.conclusion ?? job.status}</span>
        </div>
      ))}
    </div>
  );
}
