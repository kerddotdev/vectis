import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon } from "lucide-react";
import type { Snapshot } from "../../../../../packages/protocol/src/index.js";
import { List, Row, Section } from "@/components/layout";
import { StatusText } from "@/components/status";
import { Button } from "@/components/ui/button";
import { openActivity } from "@/lib/activities";
import { onboardingSteps, type OnboardingStep } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const titles = {
  environment: "Prepare an environment",
  repository: "Connect a repository",
  job: "Run a first job",
} as const satisfies Record<OnboardingStep["id"], string>;

function StepState({ step }: { step: OnboardingStep }) {
  if (step.state === "done") return <StatusText tone="success" label="Done" />;
  if (step.state === "upcoming") return <StatusText tone="idle" label="Upcoming" />;
  if (step.activity?.status === "action_required")
    return <StatusText tone="attention" label="Needs you" />;
  if (step.activity) return <StatusText tone="running" label="In progress" />;
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      <CircleDotIcon className="size-3" aria-hidden />
      Next
    </span>
  );
}

export function GetStarted({ snapshot, linked }: { snapshot: Snapshot; linked: boolean }) {
  const navigate = useNavigate();
  const steps = onboardingSteps(snapshot);
  if (!steps) return null;
  const prepared = snapshot.environments.length > 0;
  function content(step: OnboardingStep): { detail: string; action?: ReactNode } {
    const activity = step.activity;
    const progress = activity && (
      <Button size="sm" onClick={() => openActivity(activity.id)}>
        View progress
      </Button>
    );
    if (step.id === "environment") {
      if (step.state === "done") return { detail: "An environment is ready for jobs." };
      if (activity) return { detail: activity.message, action: progress };
      return prepared
        ? {
            detail: "An environment still needs setup before jobs can use it.",
            action: (
              <Button size="sm" onClick={() => void navigate({ to: "/environments" })}>
                Open Environments
              </Button>
            ),
          }
        : {
            detail: "Every job starts from a clean copy of an Ubuntu, macOS or Windows image.",
            action: (
              <Button
                size="sm"
                onClick={() => void navigate({ to: "/environments", search: { add: true } })}
              >
                Add environment
              </Button>
            ),
          };
    }
    if (step.id === "repository") {
      if (step.state === "done") return { detail: "A repository runs its jobs on this machine." };
      if (!linked)
        return {
          detail: "Connect this Mac to your Vectis account first, then link GitHub.",
          action: (
            <Button size="sm" onClick={() => void navigate({ to: "/connections" })}>
              Open Connections
            </Button>
          ),
        };
      return {
        detail: "Choose a GitHub repository whose jobs should run here.",
        action: (
          <Button
            size="sm"
            onClick={() => void navigate({ to: "/repositories", search: { connect: true } })}
          >
            Connect repository
          </Button>
        ),
      };
    }
    if (step.state === "done") return { detail: "GitHub sent a job to this machine." };
    if (activity) return { detail: activity.message, action: progress };
    return {
      detail:
        "Start a runner from Repositories, or push to a workflow that uses its runs-on label.",
      action: (
        <Button size="sm" onClick={() => void navigate({ to: "/repositories" })}>
          Open Repositories
        </Button>
      ),
    };
  }
  return (
    <Section title="Get started">
      <List>
        {steps.map((step, index) => {
          const { detail, action } = content(step);
          return (
            <Row
              key={step.id}
              leading={
                <span
                  aria-hidden
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums ring-1 ring-border ring-inset",
                    step.state === "upcoming" && "text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
              }
              title={
                <span className={cn(step.state === "upcoming" && "text-muted-foreground")}>
                  {titles[step.id]}
                </span>
              }
              detail={
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  <StepState step={step} />
                  <span>· {detail}</span>
                </span>
              }
              trailing={step.state === "current" ? action : undefined}
            />
          );
        })}
      </List>
    </Section>
  );
}
