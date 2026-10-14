import { Fragment, useMemo, useState } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hunkDiff, type DiffLine } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export function MigrationDiff({
  before,
  after,
  diff,
}: {
  before: string;
  after: string;
  diff: readonly DiffLine[] | undefined;
}) {
  const [full, setFull] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="font-medium">Proposed changes</p>
        {diff && (
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={full}
            className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
            onClick={() => setFull(!full)}
          >
            Show full files
          </Button>
        )}
      </div>
      {!diff && (
        <p className="text-xs text-muted-foreground">
          This change is too large for an inline diff, so both versions are shown in full.
        </p>
      )}
      {diff && !full ? <UnifiedDiff diff={diff} /> : <FullFiles before={before} after={after} />}
    </div>
  );
}

function UnifiedDiff({ diff }: { diff: readonly DiffLine[] }) {
  const segments = useMemo(() => hunkDiff(diff), [diff]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  return (
    <div
      data-selectable
      className="max-h-96 overflow-auto rounded-lg bg-muted py-1.5 font-mono text-[12px] leading-relaxed"
    >
      <div className="min-w-max">
        {segments.map((segment, index) =>
          segment.kind === "lines" || expanded.has(index) ? (
            <Fragment key={index}>
              {segment.lines.map((line) => (
                <Line
                  key={`${line.kind}-${line.kind === "add" ? line.after : line.before}`}
                  line={line}
                />
              ))}
            </Fragment>
          ) : (
            <button
              key={index}
              type="button"
              onClick={() => setExpanded(new Set(expanded).add(index))}
              className="flex w-full items-center gap-2 px-3 py-0.5 font-sans text-xs text-muted-foreground outline-none ring-inset hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <ChevronsUpDownIcon className="size-3" aria-hidden />
              {segment.lines.length} unchanged lines
            </button>
          ),
        )}
      </div>
    </div>
  );
}

const lineStyles = {
  equal: { sign: " ", label: undefined, row: "", signClass: "" },
  remove: { sign: "-", label: "Removed", row: "bg-danger/8", signClass: "text-danger" },
  add: { sign: "+", label: "Added", row: "bg-success/8", signClass: "text-success" },
} as const;

function Line({ line }: { line: DiffLine }) {
  const style = lineStyles[line.kind];
  return (
    <div className={cn("grid grid-cols-[2.75rem_2.75rem_1.5rem_auto] pr-4", style.row)}>
      <span className="pr-2 text-right text-muted-foreground/70 tabular-nums select-none">
        {"before" in line ? line.before : ""}
      </span>
      <span className="pr-2 text-right text-muted-foreground/70 tabular-nums select-none">
        {"after" in line ? line.after : ""}
      </span>
      <span className={cn("text-center select-none", style.signClass)}>
        <span aria-hidden>{style.sign}</span>
        {style.label && <span className="sr-only">{style.label}</span>}
      </span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  );
}

function FullFiles({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {[
        ["Current workflow", before],
        ["Proposed workflow", after],
      ].map(([label, source]) => (
        <div key={label} className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
          <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-relaxed">
            {source}
          </pre>
        </div>
      ))}
    </div>
  );
}
