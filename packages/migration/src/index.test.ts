import { expect, test } from "vitest";
import { previewMigration } from "./index.js";
const targets = [{ from: "ubuntu-24.04-arm", to: "vectis-linux-arm64" }];
test("preserves comments and unrelated jobs, with idempotent migration", () => {
  const source =
    "# CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04-arm # native\n    steps:\n      - run: echo hello\n  other:\n    runs-on: ubuntu-latest\n";
  const result = previewMigration(source, targets);
  expect(result.changed).toBe(true);
  expect(result.source).toContain("# CI");
  expect(result.source).toContain("# native");
  expect(result.source).toContain("runs-on: ubuntu-latest");
  expect(previewMigration(result.source, targets).changed).toBe(false);
});
test("does not migrate privileged events or infer x64 compatibility", () => {
  expect(
    previewMigration(
      "on: pull_request_target\njobs:\n  test:\n    runs-on: ubuntu-24.04-arm\n",
      targets,
    ).changed,
  ).toBe(false);
  const result = previewMigration("on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n", [
    { from: "ubuntu-latest", to: "vectis-linux-arm64" },
  ]);
  expect(result.changed).toBe(false);
  expect(result.findings[0]?.reason).toContain("Architecture");
});
test("migrates a simple static matrix but refuses include/exclude expansions", () => {
  const source =
    "on: push\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-24.04-arm, windows-latest]\n";
  expect(previewMigration(source, targets).source).toContain("vectis-linux-arm64");
  expect(previewMigration(source + "        include: []\n", targets).changed).toBe(false);
});

test("reports jobs that already run on a Vectis label instead of returning nothing", () => {
  const preview = previewMigration(
    "on: push\njobs:\n  build:\n    runs-on: vectis-ubuntu\n  other:\n    runs-on: ubuntu-24.04-arm\n",
    targets,
  );
  expect(preview.changed).toBe(true);
  expect(preview.source).toContain("runs-on: vectis-ubuntu");
  expect(preview.findings).toEqual([
    { job: "build", reason: expect.stringContaining("Already runs on vectis-ubuntu") },
  ]);
});

test("aliased privileged triggers cannot bypass migration review", () => {
  for (const trigger of ["*event", "[*event, push]"]) {
    const source = `event: &event pull_request_target\non: ${trigger}\njobs:\n  test:\n    runs-on: ubuntu-24.04-arm\n`;
    const preview = previewMigration(source, targets);
    expect(preview.changed).toBe(false);
    expect(preview.source).toBe(source);
    expect(preview.findings[0]?.reason).toContain("Aliased");
  }
});
