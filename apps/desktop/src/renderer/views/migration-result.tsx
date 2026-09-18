import { Schema } from "effect";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import {
  MigrationAnalysis,
  MigrationPublication,
} from "../../../../../packages/protocol/src/migrations.js";
import { Mono, Notice } from "@/components/layout";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useStateApi } from "@/state";

export function MigrationResult({ result }: { result: unknown }) {
  const { submit, perform } = useStateApi();
  if (Schema.is(MigrationPublication)(result))
    return (
      <div className="flex items-center gap-3">
        <span>
          Pull request #{result.number}: {result.state}
        </span>
        <Button variant="secondary" size="sm" onClick={() => void perform("open.pull", result.url)}>
          <ExternalLinkIcon />
          Open on GitHub
        </Button>
      </div>
    );
  if (!Schema.is(MigrationAnalysis)(result)) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Preview <Mono>{result.previewId}</Mono> from {result.baseBranch} at{" "}
        <Mono>{result.baseCommit.slice(0, 12)}</Mono>
      </p>
      {!result.verified && (
        <Notice tone="attention">
          A successful job and verified runner cleanup are required before publication. Complete
          that check, then analyze again.
        </Notice>
      )}
      {result.files.length === 0 && (
        <p className="text-muted-foreground">No workflow files found.</p>
      )}
      {result.files.map((file) => (
        <Collapsible key={file.path} className="rounded-xl ring-1 ring-border ring-inset">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
            <Mono className="flex-1 text-foreground">{file.path}</Mono>
            <StatusBadge
              tone={file.changed ? "attention" : "idle"}
              label={file.changed ? "Changes proposed" : "Unchanged"}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 px-3 pb-3">
              {file.findings.map((finding, index) => (
                <p key={index} className="text-muted-foreground">
                  <span className="text-foreground">{finding.job}</span>: {finding.reason}
                </p>
              ))}
              {file.changed && (
                <div className="grid gap-3 lg:grid-cols-2">
                  {[
                    ["Current workflow", file.before],
                    ["Proposed workflow", file.after],
                  ].map(([label, source]) => (
                    <div key={label} className="min-w-0">
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
                      <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-relaxed">
                        {source}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
      <div>
        <Button
          size="sm"
          disabled={!result.verified || !result.files.some((file) => file.changed)}
          onClick={() => void submit({ type: "migration.publish", previewId: result.previewId })}
        >
          Create or recover migration PR
        </Button>
      </div>
    </div>
  );
}
