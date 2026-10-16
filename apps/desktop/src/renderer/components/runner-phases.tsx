import { StatusText } from "@/components/status";
import type { PhaseTimeline } from "@/lib/runner-phases";
import { cn } from "@/lib/utils";

export function RunnerPhases({ timeline }: { timeline: PhaseTimeline }) {
  return (
    <div className="flex max-w-[72ch] flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Timing</p>
      <ol className="grid grid-cols-[minmax(8rem,max-content)_1fr_minmax(4.5rem,max-content)] items-center gap-x-4 gap-y-1.5 text-xs">
        {timeline.rows.map((row) => (
          <li key={row.name} className="col-span-3 grid grid-cols-subgrid items-center">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-foreground/85">{row.label}</span>
              {row.count > 1 && <span className="text-muted-foreground">{row.count} times</span>}
              {row.state === "running" && <StatusText tone="running" label="Running" />}
              {row.state === "unfinished" && <StatusText tone="idle" label="No end recorded" />}
            </span>
            <span aria-hidden className="relative h-1.5 rounded-full bg-hairline">
              {row.segments.map((segment, index) => (
                <span
                  key={index}
                  className={cn(
                    "absolute inset-y-0 rounded-full",
                    row.state === "running" ? "bg-running" : "bg-muted-foreground/45",
                  )}
                  style={{
                    left: `${segment.offset * 100}%`,
                    width: `max(3px, ${segment.width * 100}%)`,
                  }}
                />
              ))}
            </span>
            <span className="text-right font-mono text-foreground/85 tabular-nums">
              {row.duration}
            </span>
          </li>
        ))}
        <li className="col-span-3 grid grid-cols-subgrid items-center pt-1">
          <span className="font-medium">Total</span>
          <span aria-hidden />
          <span className="text-right font-mono font-medium tabular-nums">{timeline.total}</span>
        </li>
      </ol>
    </div>
  );
}
