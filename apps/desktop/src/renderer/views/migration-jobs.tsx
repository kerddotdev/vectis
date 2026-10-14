import type { MigrationJob } from "../../../../../packages/protocol/src/migrations.js";
import { StatusText } from "@/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { layoutJobGraph, type GraphNode } from "@/lib/job-graph";

const metrics = { nodeWidth: 216, nodeHeight: 84, columnGap: 40, rowGap: 12 };

export function MigrationJobs({
  jobs,
  labels,
}: {
  jobs: readonly MigrationJob[];
  labels: ReadonlyMap<string, readonly string[]> | undefined;
}) {
  const layout = layoutJobGraph(jobs, metrics);
  const moving = jobs.filter((job) => job.changed).length;
  const unknownNeeds = jobs.filter((job) => job.needs === undefined).length;
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <p className="font-medium">
          {moving} of {jobs.length} {jobs.length === 1 ? "job moves" : "jobs move"} to Vectis
        </p>
        {unknownNeeds > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Dependencies of {unknownNeeds} {unknownNeeds === 1 ? "job" : "jobs"} could not be read
            and are not drawn.
          </p>
        )}
      </div>
      <div className="max-h-[26rem] overflow-auto">
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edge.path}
                className="fill-none stroke-hairline-strong"
                strokeWidth={1.25}
              />
            ))}
          </svg>
          <ul aria-label="Workflow jobs" className="absolute inset-0">
            {layout.nodes.map((node) => (
              <JobNode key={node.job.job} node={node} labels={labels?.get(node.job.job)} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function JobNode({
  node,
  labels,
}: {
  node: GraphNode<MigrationJob>;
  labels: readonly string[] | undefined;
}) {
  const { job, changed, reasons, needs } = node.job;
  const details = [
    ...(changed && labels ? [`Runs on ${labels.join(", ")}`] : []),
    ...(changed || reasons.length > 0 ? reasons : ["No runner label to replace."]),
  ];
  const body = (
    <div
      tabIndex={0}
      className="flex size-full flex-col gap-1 rounded-xl bg-background px-3 py-2.5 ring-1 ring-border outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="truncate font-medium">{job}</span>
      <span className="text-xs">
        {changed ? (
          <StatusText tone="success" label="Moves to Vectis" />
        ) : (
          <StatusText tone="idle" label="Not moved" />
        )}
      </span>
      {changed && labels ? (
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {labels.join(", ")}
        </span>
      ) : (
        details.length > 0 && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{details.join(" ")}</span>
        )
      )}
      {needs && needs.length > 0 && <span className="sr-only">Needs {needs.join(", ")}</span>}
    </div>
  );
  return (
    <li
      className="absolute"
      style={{
        left: node.x,
        top: node.y,
        width: metrics.nodeWidth,
        height: metrics.nodeHeight,
      }}
    >
      {details.length > 0 ? (
        <Tooltip>
          <TooltipTrigger render={body} />
          <TooltipContent className="flex max-w-72 flex-col items-start gap-1 leading-relaxed">
            {details.map((detail, index) => (
              <span key={index}>{detail}</span>
            ))}
          </TooltipContent>
        </Tooltip>
      ) : (
        body
      )}
    </li>
  );
}
