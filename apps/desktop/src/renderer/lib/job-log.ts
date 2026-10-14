import type { JobLogs } from "../../../../../packages/protocol/src/jobs.js";

export type LoadedLog = {
  text: string;
  next: number;
  complete: boolean;
  truncated: boolean;
};

export const emptyLog: LoadedLog = { text: "", next: 0, complete: false, truncated: false };

// Chunks are absolute byte ranges. One that does not move the cursor forward is a repeat.
export function appendChunk(log: LoadedLog, chunk: JobLogs): LoadedLog {
  const fresh = chunk.text !== "" && chunk.next > log.next;
  return {
    text: fresh ? log.text + chunk.text : log.text,
    next: fresh ? chunk.next : log.next,
    complete: chunk.complete,
    truncated: chunk.truncated,
  };
}

const escape = String.fromCharCode(27);
const csiSequence = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string) {
  return text.replace(csiSequence, "");
}

export type LogSegmentKind = "plain" | "error" | "marker";
export type LogSegment = { kind: LogSegmentKind; text: string };

// GitHub puts a timestamp before the workflow command on every line.
const command = /^(?:\S+Z )?##\[(\w+)\]/;

function lineKind(line: string): LogSegmentKind {
  const name = command.exec(line)?.[1];
  if (name === "error") return "error";
  if (name === "group" || name === "endgroup") return "marker";
  return "plain";
}

// Neighbouring lines of one kind share a segment, so a log of many thousands of lines stays a
// handful of elements.
export function segmentLog(text: string): LogSegment[] {
  const segments: LogSegment[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const kind = lineKind(line);
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += line;
    else segments.push({ kind, text: line });
  }
  return segments;
}
