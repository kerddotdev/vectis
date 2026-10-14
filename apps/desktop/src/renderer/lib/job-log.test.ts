import { expect, test } from "vitest";
import { appendChunk, emptyLog, segmentLog, stripAnsi } from "./job-log";

const chunk = (text: string, next: number, complete = false) => ({
  text,
  next,
  status: "in_progress" as const,
  complete,
  truncated: false,
});

test("chunks accumulate by cursor and a repeated chunk changes nothing", () => {
  const first = appendChunk(emptyLog, chunk("one\n", 4));
  const second = appendChunk(first, chunk("two\n", 8));
  expect(second).toMatchObject({ text: "one\ntwo\n", next: 8, complete: false });
  expect(appendChunk(second, chunk("two\n", 8))).toEqual(second);
  expect(appendChunk(second, chunk("", 8, true))).toMatchObject({
    text: "one\ntwo\n",
    complete: true,
  });
});

test("colour and cursor sequences are removed and other text is kept", () => {
  expect(stripAnsi("\u001b[31;1mfailed\u001b[0m [ok] 100%")).toBe("failed [ok] 100%");
});

test("errors and group markers are told apart, with and without a timestamp", () => {
  const segments = segmentLog(
    [
      "2026-01-01T00:00:00.0000000Z ##[group]Run tests",
      "2026-01-01T00:00:01.0000000Z npm test",
      "2026-01-01T00:00:02.0000000Z ##[error]Process completed with exit code 1.",
      "##[endgroup]",
      "tail without newline",
    ].join("\n"),
  );
  expect(segments.map((segment) => segment.kind)).toEqual([
    "marker",
    "plain",
    "error",
    "marker",
    "plain",
  ]);
  expect(segments.map((segment) => segment.text).join("")).toContain("tail without newline");
});
