import { expect, test } from "vitest";
import { diffLines as maybeDiffLines, hunkDiff, maxDiffLines, type DiffLine } from "./line-diff";

function diffLines(before: string, after: string): DiffLine[] {
  const diff = maybeDiffLines(before, after);
  if (!diff) throw new Error("Expected a diff");
  return diff;
}

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

function apply(diff: readonly DiffLine[]) {
  return {
    before: diff.filter((line) => line.kind !== "add").map((line) => line.text),
    after: diff.filter((line) => line.kind !== "remove").map((line) => line.text),
  };
}

test("reports a replaced runner label as one removal and one addition with line numbers", () => {
  const before = "jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: []\n";
  const after = "jobs:\n  build:\n    runs-on: vectis-ubuntu\n    steps: []\n";
  expect(diffLines(before, after)).toEqual([
    { kind: "equal", text: "jobs:", before: 1, after: 1 },
    { kind: "equal", text: "  build:", before: 2, after: 2 },
    { kind: "remove", text: "    runs-on: ubuntu-24.04", before: 3 },
    { kind: "add", text: "    runs-on: vectis-ubuntu", after: 3 },
    { kind: "equal", text: "    steps: []", before: 4, after: 4 },
  ]);
});

test("produces a minimal edit script that reconstructs both sides", () => {
  const before = ["a", "b", "c", "a", "b", "b", "a"];
  const after = ["c", "b", "a", "b", "a", "c"];
  const diff = diffLines(before.join("\n"), after.join("\n"));
  expect(apply(diff)).toEqual({ before, after });
  expect(diff.filter((line) => line.kind !== "equal")).toHaveLength(5);
});

test("handles insertions at the edges and empty inputs", () => {
  expect(apply(diffLines("", "a\nb"))).toEqual({ before: [""], after: ["a", "b"] });
  expect(apply(diffLines("b", "a\nb\nc"))).toEqual({ before: ["b"], after: ["a", "b", "c"] });
  expect(diffLines("same\n", "same\n")).toEqual([
    { kind: "equal", text: "same", before: 1, after: 1 },
  ]);
});

test("declines files beyond the line limit instead of blocking the renderer", () => {
  const large = lines(maxDiffLines + 1).join("\n");
  expect(maybeDiffLines(large, "short")).toBeUndefined();
  expect(maybeDiffLines("short", large)).toBeUndefined();
});

test("declines diffs with too many edits", () => {
  expect(maybeDiffLines(lines(3000, "a").join("\n"), lines(3000, "b").join("\n"))).toBeUndefined();
});

test("collapses unchanged runs while keeping three lines of context around changes", () => {
  const before = lines(20);
  const after = [...before];
  after[9] = "changed";
  const segments = hunkDiff(diffLines(before.join("\n"), after.join("\n")));
  expect(segments.map((segment) => [segment.kind, segment.lines.length])).toEqual([
    ["collapsed", 6],
    ["lines", 8],
    ["collapsed", 7],
  ]);
  expect(segments[1]?.lines[0]).toMatchObject({ text: "line 7", before: 7 });
});

test("keeps nearby changes in one hunk and never hides a single line", () => {
  const before = lines(12);
  const after = [...before];
  after[0] = "first";
  after[8] = "ninth";
  const segments = hunkDiff(diffLines(before.join("\n"), after.join("\n")));
  expect(segments.map((segment) => segment.kind)).toEqual(["lines"]);

  after[8] = "line 9";
  after[11] = "last";
  const split = hunkDiff(diffLines(before.join("\n"), after.join("\n")));
  expect(split.map((segment) => [segment.kind, segment.lines.length])).toEqual([
    ["lines", 5],
    ["collapsed", 4],
    ["lines", 5],
  ]);
});
