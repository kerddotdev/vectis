import { useEffect, useState } from "react";
import { Schema } from "effect";
import { EllipsisIcon } from "lucide-react";
import { Jobs } from "../../../../../packages/protocol/src/jobs.js";
import { Notice } from "@/components/layout";
import { JobStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format";
import { useStateApi } from "@/state";

export function RepositoryJobs({ bindingId }: { bindingId: string }) {
  const { perform, submit, snapshot } = useStateApi();
  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [jobId, setJobId] = useState("");
  const [notice, setNotice] = useState<string>();
  // The service raises its revision when GitHub reports something new for this repository, so the
  // list follows the jobs by itself. A service too old to report one still moves its operations.
  const revision = snapshot?.revision ?? `${snapshot?.operations.length ?? 0}`;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await perform("jobs", bindingId);
          if (value !== undefined && !cancelled) setJobs(Schema.decodeUnknownSync(Jobs)(value));
        } catch {
          if (!cancelled) setNotice("GitHub job records could not be read.");
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bindingId, revision]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">Latest GitHub jobs</p>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Job recovery actions" />}
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={() => void submit({ type: "job.scan", bindingId })}>
                Discover missing jobs
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRecovering(true)}>
                Recover a job by ID…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {notice && (
        <Notice tone="danger" role="alert">
          {notice}
        </Notice>
      )}
      {jobs?.length === 0 && (
        <p className="text-muted-foreground">
          No GitHub jobs have been observed for this repository yet.
        </p>
      )}
      {jobs && jobs.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-border ring-inset">
          {jobs.map((job) => (
            <div key={job.jobId} className="flex items-center gap-3 px-3.5 py-2.5">
              <Tooltip>
                <TooltipTrigger
                  render={<span tabIndex={0} />}
                  className="min-w-0 flex-1 truncate rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {job.name}
                </TooltipTrigger>
                <TooltipContent>
                  Run {job.runId}, job {job.jobId}
                  {job.runnerName ? `, runner ${job.runnerName}` : ""}
                </TooltipContent>
              </Tooltip>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatRelative(job.updatedAt)}
              </span>
              <JobStatus status={job.status} conclusion={job.conclusion} />
            </div>
          ))}
        </div>
      )}
      <Dialog open={recovering} onOpenChange={setRecovering}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recover a GitHub job</DialogTitle>
            <DialogDescription>
              Reads one job from GitHub again, for example after the service missed its update.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              const id = Number(jobId);
              if (!Number.isSafeInteger(id) || id <= 0) return;
              void submit({ type: "job.refresh", bindingId, jobId: id }).then((value) => {
                if (value !== undefined) setRecovering(false);
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${bindingId}-job`}>GitHub job ID</FieldLabel>
              <Input
                id={`${bindingId}-job`}
                value={jobId}
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                required
                onChange={(event) => setJobId(event.target.value)}
              />
              <FieldDescription>
                The number after /job/ in the job's URL on GitHub.
              </FieldDescription>
            </Field>
            <div className="flex justify-end">
              <Button type="submit">Recover job</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
