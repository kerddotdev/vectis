import { ExternalLinkIcon } from "lucide-react";
import type { Activity, Operation } from "../../../../../packages/protocol/src/index.js";
import { GitHubIcon } from "@/components/github-icon";
import { Details, ExpandableRow, Mono } from "@/components/layout";
import { OsTile } from "@/components/os-icon";
import { JobStatus, OperationStatus, StatusText } from "@/components/status";
import { Button } from "@/components/ui/button";
import { activityJob, activitySummary, activityTitle } from "@/lib/activities";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cancellableCommands, commandLabels } from "@/lib/operations";
import { MigrationResult } from "@/views/migration-result";
import { PreparationResult } from "@/views/preparation-result";
import { useStateApi } from "@/state";

function VectisTile() {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-xs font-semibold text-foreground/70">
      V
    </span>
  );
}

export function ActivityRow({
  activity,
  defaultOpen = false,
}: {
  activity: Activity;
  defaultOpen?: boolean;
}) {
  const { snapshot, submit, perform } = useStateApi();
  const operations = (snapshot?.operations ?? []).filter(
    (operation) => operation.activityId === activity.id,
  );
  // Operations arrive newest first; an activity reads as the story of what happened.
  const steps = [...operations].reverse();
  const deciding =
    activity.subject.type === "preparation"
      ? steps.at(-1)
      : steps.find((step) => step.id === activity.rootOperationId);
  const job = activityJob(activity);
  const running = activity.status === "accepted" || activity.status === "running";
  const cancellable = steps.some(
    (step) =>
      (step.status === "running" || step.status === "accepted") &&
      cancellableCommands.includes(step.command),
  );
  const reconcilable = activity.subject.type === "runner" && activity.status === "action_required";
  const preparation = activity.subject.type === "preparation";
  const closable = activity.status === "action_required" && !preparation && !reconcilable;
  const result: unknown = deciding?.result;
  const nextStep =
    typeof result === "object" &&
    result &&
    "nextStep" in result &&
    typeof result.nextStep === "string"
      ? result.nextStep
      : undefined;
  return (
    <ExpandableRow
      defaultOpen={defaultOpen}
      leading={
        activity.kind === "github" ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/80">
            <GitHubIcon className="size-[18px]" />
          </span>
        ) : activity.subject.type === "preparation" ? (
          <OsTile os={activity.subject.os} />
        ) : (
          <VectisTile />
        )
      }
      title={activityTitle(activity, snapshot)}
      summary={activitySummary(activity, snapshot)}
      aside={
        <>
          <span className="hidden text-xs text-muted-foreground tabular-nums @2xl:inline">
            {formatRelative(activity.updatedAt)}
          </span>
          {job?.status && <JobStatus status={job.status} conclusion={job.conclusion ?? null} />}
          <OperationStatus status={activity.status} />
        </>
      }
    >
      <p className="max-w-[72ch] text-foreground/85" data-selectable>
        {activity.message}
      </p>
      {nextStep && (
        <p className="max-w-[72ch] text-muted-foreground" data-selectable>
          {nextStep}
        </p>
      )}
      {job?.htmlUrl && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void perform("open.url", job.htmlUrl)}
          >
            <GitHubIcon className="size-3.5" />
            Open job on GitHub
            <ExternalLinkIcon />
          </Button>
        </div>
      )}
      {preparation && deciding && (
        <PreparationResult
          result={deciding.result}
          macos={deciding.command.includes("macos")}
          windows={deciding.command.includes("windows")}
          resumable={deciding.status === "action_required"}
        />
      )}
      {deciding?.command.startsWith("migration.") && deciding.status === "succeeded" && (
        <MigrationResult result={deciding.result} />
      )}
      {steps.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Steps</p>
          <ol className="flex flex-col gap-2 border-l border-hairline-strong pl-4">
            {steps.map((step) => (
              <Step key={step.id} step={step} />
            ))}
          </ol>
        </div>
      )}
      <Details
        items={[
          ["Started", formatDateTime(activity.createdAt)],
          ["Last update", formatDateTime(activity.updatedAt)],
          ...(activity.completedAt
            ? ([["Finished", formatDateTime(activity.completedAt)]] as const)
            : []),
          ...(activity.repository ? ([["Repository", activity.repository.name]] as const) : []),
          ...(job
            ? ([
                [
                  "GitHub job",
                  <Mono key="job">
                    {job.runId ? `run ${job.runId}, job ${job.jobId}` : String(job.jobId)}
                  </Mono>,
                ],
              ] as const)
            : []),
          ["Activity ID", <Mono key="id">{activity.id}</Mono>],
        ]}
      />
      {(cancellable || reconcilable || closable) && (
        <div className="flex flex-wrap gap-2">
          {closable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submit({ type: "activity.cancel", id: activity.id })}
            >
              Dismiss
            </Button>
          )}
          {reconcilable && deciding && (
            <Button
              size="sm"
              onClick={() => void submit({ type: "runner.reconcile", id: deciding.id })}
            >
              Reconcile runner
            </Button>
          )}
          {cancellable && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submit({ type: "activity.cancel", id: activity.id })}
            >
              {running && activity.subject.type === "runner" ? "Stop runner" : "Cancel"}
            </Button>
          )}
        </div>
      )}
    </ExpandableRow>
  );
}

const stepTones = {
  accepted: "queued",
  running: "running",
  action_required: "attention",
  succeeded: "success",
  failed: "danger",
  cancelled: "cancelled",
} as const;

function Step({ step }: { step: Operation }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <StatusText
        tone={stepTones[step.status]}
        label={commandLabels[step.command] ?? step.command}
      />
      <span className="text-muted-foreground tabular-nums">{formatRelative(step.updatedAt)}</span>
      <span className="min-w-0 basis-full text-muted-foreground" data-selectable>
        {step.message}
      </span>
    </li>
  );
}
