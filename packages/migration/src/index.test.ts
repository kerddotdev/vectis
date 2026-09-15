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
