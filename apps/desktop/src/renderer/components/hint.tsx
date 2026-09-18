import type { ReactElement, ReactNode } from "react";
import { CircleHelpIcon, CpuIcon, MemoryStickIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMemory } from "@/lib/format";

export function Hint({
  label = "More information",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="inline-grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <CircleHelpIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-72 leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}

export function Reason({
  reason,
  children,
}: {
  reason: string | false | undefined;
  children: ReactElement;
}) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 leading-relaxed">{reason}</TooltipContent>
    </Tooltip>
  );
}

function Meta({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
      >
        <span className="inline-flex items-center gap-1" aria-hidden>
          {icon}
          {children}
        </span>
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Resources({
  cpu,
  memoryMiB,
}: {
  cpu: number | undefined;
  memoryMiB: number | undefined;
}) {
  return (
    <span className="inline-flex items-center gap-3">
      {cpu !== undefined && (
        <Meta icon={<CpuIcon className="size-3.5" />} label={`${cpu} CPU cores`}>
          {cpu}
        </Meta>
      )}
      {memoryMiB !== undefined && (
        <Meta
          icon={<MemoryStickIcon className="size-3.5" />}
          label={`${formatMemory(memoryMiB)} memory (${memoryMiB} MiB)`}
        >
          {formatMemory(memoryMiB)}
        </Meta>
      )}
    </span>
  );
}
