export type DiffLine =
  | {
      readonly kind: "equal";
      readonly text: string;
      readonly before: number;
      readonly after: number;
    }
  | { readonly kind: "remove"; readonly text: string; readonly before: number }
  | { readonly kind: "add"; readonly text: string; readonly after: number };

export type DiffSegment =
  | { readonly kind: "lines"; readonly lines: readonly DiffLine[] }
  | { readonly kind: "collapsed"; readonly lines: readonly DiffLine[] };

export const maxDiffLines = 4000;
const maxEdits = 2000;

function splitLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function editScript(
  a: readonly string[],
  b: readonly string[],
): ("equal" | "remove" | "add")[] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  const furthest = (k: number) => v[offset + k] ?? 0;
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, maxEdits); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && furthest(k - 1) < furthest(k + 1))
          ? furthest(k + 1)
          : furthest(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (furthest(n - m) === n && Math.abs(n - m) <= d && (n - m - d) % 2 === 0) {
      found = d;
      break;
    }
  }
  if (found < 0) return undefined;
  const script: ("equal" | "remove" | "add")[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1];
    const at = (k: number) => previous?.[k + d - 1] ?? 0;
    const k = x - y;
    const fromAbove = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = fromAbove ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      script.push("equal");
      x--;
      y--;
    }
    script.push(fromAbove ? "add" : "remove");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    script.push("equal");
    x--;
    y--;
  }
  return script.reverse();
}

export function diffLines(before: string, after: string): DiffLine[] | undefined {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > maxDiffLines || b.length > maxDiffLines) return undefined;
  const script = editScript(a, b);
  if (!script) return undefined;
  const lines: DiffLine[] = [];
  let x = 0;
  let y = 0;
  for (const step of script) {
    if (step === "equal") lines.push({ kind: "equal", text: a[x] ?? "", before: ++x, after: ++y });
    else if (step === "remove") lines.push({ kind: "remove", text: a[x] ?? "", before: ++x });
    else lines.push({ kind: "add", text: b[y] ?? "", after: ++y });
  }
  return lines;
}

export function hunkDiff(lines: readonly DiffLine[], context = 3): DiffSegment[] {
  const runs: DiffLine[][] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && (last[0]?.kind === "equal") === (line.kind === "equal")) last.push(line);
    else runs.push([line]);
  }
  const segments: DiffSegment[] = [];
  let visible: DiffLine[] = [];
  runs.forEach((run, index) => {
    const keepStart = index === 0 ? 0 : context;
    const keepEnd = index === runs.length - 1 ? 0 : context;
    if (run[0]?.kind !== "equal" || run.length - keepStart - keepEnd <= 1) {
      visible.push(...run);
      return;
    }
    visible.push(...run.slice(0, keepStart));
    if (visible.length > 0) segments.push({ kind: "lines", lines: visible });
    segments.push({ kind: "collapsed", lines: run.slice(keepStart, run.length - keepEnd) });
    visible = run.slice(run.length - keepEnd);
  });
  if (visible.length > 0) segments.push({ kind: "lines", lines: visible });
  return segments;
}
