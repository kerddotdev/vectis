import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, CircleCheckIcon } from "lucide-react";
import type { ReadinessCheck } from "../../../../../packages/protocol/src/readiness.js";
import { StatusText, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  areaLabels,
  readinessRoute,
  readinessSection,
  summarizeReadiness,
  type ReadinessStatus,
} from "@/lib/readiness";
import { revealSection } from "@/lib/reveal";
import { cn } from "@/lib/utils";

export const readinessStates = {
  ok: ["success", "Passed"],
  attention: ["attention", "Attention"],
  blocked: ["danger", "Blocked"],
  unknown: ["unsupported", "Unknown"],
} as const satisfies Record<ReadinessStatus, readonly [Tone, string]>;

export function ReadinessState({ status }: { status: ReadinessStatus }) {
  const [tone, label] = readinessStates[status];
  return <StatusText tone={tone} label={label} />;
}

const indicatorLabels = {
  attention: "Needs attention",
  blocked: "Blocked",
  unknown: "Not verified",
} as const;

export function ReadinessIndicator({ status }: { status: ReadinessStatus }) {
  if (status === "ok") return null;
  return <StatusText tone={readinessStates[status][0]} label={indicatorLabels[status]} />;
}

export function ReadinessList({
  checks,
  titles,
  className,
}: {
  checks: readonly ReadinessCheck[];
  titles?: Partial<Record<string, string>>;
  className?: string;
}) {
  const { passed, open } = summarizeReadiness(checks);
  if (!checks.length) return null;
  return (
    <div className={cn("flex flex-col divide-y divide-border", className)}>
      {open.map((check) => (
        <CheckRow key={check.id} check={check} title={titles?.[check.id]} />
      ))}
      {passed.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group/passed flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset">
            <CircleCheckIcon className="size-3 text-success" aria-hidden />
            <span className="flex-1 text-muted-foreground">
              {passed.length} {passed.length === 1 ? "check" : "checks"} passed
            </span>
            <ChevronRightIcon
              className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-panel-open/passed:rotate-90"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col divide-y divide-border border-t border-border">
              {passed.map((check) => (
                <CheckRow key={check.id} check={check} title={titles?.[check.id]} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function CheckRow({ check, title }: { check: ReadinessCheck; title: string | undefined }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const target = check.target;
  const route = target && readinessRoute(target);
  const section = target && readinessSection(target);
  const actionable = check.status !== "ok" && target && route && route !== pathname;
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3.5 py-2.5">
      <span className="pt-px text-xs">
        <ReadinessState status={check.status} />
      </span>
      <div className="min-w-0" data-selectable>
        <p className={cn(title && "font-medium")}>{title ?? check.message}</p>
        {title && <p className="mt-0.5 text-xs text-muted-foreground">{check.message}</p>}
        {check.status !== "ok" && check.nextStep && (
          <p className="mt-0.5 text-xs text-muted-foreground">{check.nextStep}</p>
        )}
      </div>
      {actionable ? (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => {
            void navigate({ to: route }).then(() => {
              if (section) revealSection(section);
            });
          }}
        >
          Open {areaLabels[target.area]}
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}
