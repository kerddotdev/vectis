import { Schema } from "effect";
import type { PhaseName } from "../../../../../packages/protocol/src/runners.js";

const labels = {
  queued_locally: "Queued locally",
  job_check: "Job check",
  vm_start: "VM start",
  warm_takeover: "Warm takeover",
  vm_start_and_guest_ready: "VM start and guest ready",
  guest_ready: "Guest ready",
  runner_install: "Runner install",
  runner_preinstalled: "Runner preinstalled",
  registration: "Registration",
  waiting_for_job: "Waiting for job",
  job: "Job",
  cleanup: "Cleanup",
} as const satisfies Record<PhaseName, string>;

// Names stay plain strings so a newer service's phases still render.
const PhasesResult = Schema.Struct({
  phases: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      startedAt: Schema.String,
      endedAt: Schema.optional(Schema.String),
    }),
  ),
});
const isPhasesResult = Schema.is(PhasesResult);

export type PhaseState = "done" | "running" | "unfinished";

export interface PhaseRow {
  name: string;
  label: string;
  count: number;
  durationMs: number;
  duration: string;
  state: PhaseState;
  segments: Array<{ offset: number; width: number }>;
}

export interface PhaseTimeline {
  rows: PhaseRow[];
  totalMs: number;
  total: string;
}

export function formatDuration(ms: number) {
  if (ms < 100) return "< 0.1 s";
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const knownLabels: Partial<Record<string, string>> = labels;

function phaseLabel(name: string) {
  const known = Object.hasOwn(knownLabels, name) ? knownLabels[name] : undefined;
  if (known) return known;
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// An open phase runs until `end` while the runner is active; otherwise its end was never recorded.
export function runnerPhaseTimeline(
  result: unknown,
  { end, active }: { end: number; active: boolean },
): PhaseTimeline | undefined {
  if (!isPhasesResult(result)) return undefined;
  const spans = result.phases
    .map((phase) => {
      const start = Date.parse(phase.startedAt);
      const recordedEnd = phase.endedAt === undefined ? Number.NaN : Date.parse(phase.endedAt);
      const open = Number.isNaN(recordedEnd);
      return {
        name: phase.name,
        start,
        end: Math.max(start, open ? end : recordedEnd),
        open,
      };
    })
    .filter((span) => !Number.isNaN(span.start))
    .sort((a, b) => a.start - b.start);
  const first = spans[0];
  if (!first) return undefined;
  const totalMs = Math.max(...spans.map((span) => span.end)) - first.start;

  const rows = new Map<string, PhaseRow>();
  for (const span of spans) {
    const row = rows.get(span.name) ?? {
      name: span.name,
      label: phaseLabel(span.name),
      count: 0,
      durationMs: 0,
      duration: "",
      state: "done",
      segments: [],
    };
    row.count += 1;
    row.durationMs += span.end - span.start;
    if (span.open) row.state = active ? "running" : "unfinished";
    row.segments.push(
      totalMs > 0
        ? { offset: (span.start - first.start) / totalMs, width: (span.end - span.start) / totalMs }
        : { offset: 0, width: 0 },
    );
    rows.set(span.name, row);
  }
  return {
    rows: [...rows.values()].map((row) => ({ ...row, duration: formatDuration(row.durationMs) })),
    totalMs,
    total: formatDuration(totalMs),
  };
}
