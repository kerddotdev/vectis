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

const styledWorkflow = `---
# CI keeps its hand-written layout.
name: "Build and test"
on: [push, pull_request]
env: &shared { CI: 'true', MESSAGE: "A long message that should stay on one line even when it exceeds the serializer's default eighty character limit." }
jobs:
    plain:
        # Native ARM64 runner.
        runs-on: ubuntu-24.04-arm # Keep this inline comment.
        env: *shared
        steps:
            - run: |
                echo "This shell command is intentionally longer than eighty characters and must remain exactly as written by the workflow author."

    single:
        needs: plain
        runs-on: 'ubuntu-24.04-arm'
        steps: [{ run: 'echo single' }]

    double:
        needs: [plain, single]
        runs-on: "ubuntu-24.04-arm"
        steps:
            - run: echo double

    self_hosted:
        runs-on: [self-hosted, linux] # Existing runner selection stays intact.
        steps: [{ run: 'echo self hosted' }]

    matrix:
        runs-on: \${{ matrix.os }}
        strategy:
            matrix: { os: [ubuntu-24.04-arm, 'ubuntu-24.04-arm', "ubuntu-24.04-arm", windows-latest] }
        steps:
            - run: echo matrix
...
`;

test.each([
  { name: "LF with a trailing newline", source: styledWorkflow },
  { name: "LF without a trailing newline", source: styledWorkflow.trimEnd() },
  { name: "CRLF with a trailing newline", source: styledWorkflow.replaceAll("\n", "\r\n") },
  {
    name: "CRLF without a trailing newline",
    source: styledWorkflow.trimEnd().replaceAll("\n", "\r\n"),
  },
])("changes only label scalars in $name", ({ source }) => {
  const preview = previewMigration(source, targets);
  expect(preview.changed).toBe(true);
  expect(preview.source).toBe(source.replaceAll("ubuntu-24.04-arm", "vectis-linux-arm64"));
  expect(previewMigration(preview.source, targets).source).toBe(preview.source);
});

test("replaces only selected scalar occurrences, not identical text elsewhere", () => {
  const source = `on: push
# ubuntu-24.04-arm is the original runner.
name: ubuntu-24.04-arm
jobs:
  build:
    runs-on: ubuntu-24.04-arm
    steps:
      - run: echo ubuntu-24.04-arm
  self_hosted:
    runs-on: [self-hosted, ubuntu-24.04-arm]
`;
  expect(previewMigration(source, targets).source).toBe(
    source.replace("runs-on: ubuntu-24.04-arm", "runs-on: vectis-linux-arm64"),
  );
});

test.each([
  {
    name: "anchored",
    scalar: "&runner ubuntu-24.04-arm",
    extra: "  alias:\n    runs-on: *runner\n",
  },
  { name: "tagged", scalar: "!!str ubuntu-24.04-arm", extra: "" },
  { name: "block", scalar: "|-\n      ubuntu-24.04-arm", extra: "" },
  { name: "multiline quoted", scalar: '"ubuntu-24.04-\\\n      arm"', extra: "" },
])("refuses an unsafe $name scalar while preserving safe changes", ({ scalar, extra }) => {
  const source = `on: push
jobs:
  review:
    runs-on: ${scalar}
${extra}  safe:
    runs-on: 'ubuntu-24.04-arm'
`;
  const preview = previewMigration(source, targets);
  expect(preview.source).toBe(
    source.replace("runs-on: 'ubuntu-24.04-arm'", "runs-on: 'vectis-linux-arm64'"),
  );
  expect(preview.findings).toContainEqual({
    job: "review",
    reason: expect.stringContaining("cannot be safely replaced"),
  });
  expect(preview.jobs).toContainEqual(expect.objectContaining({ job: "review", changed: false }));
});

test.each([
  "strategy: &strategy\n      matrix:\n        os: [ubuntu-24.04-arm]",
  "strategy:\n      matrix: &matrix\n        os: [ubuntu-24.04-arm]",
  "strategy:\n      matrix:\n        os: &runners [ubuntu-24.04-arm]",
])("refuses shared matrix selections", (strategy) => {
  const source = `on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    ${strategy}
`;
  const preview = previewMigration(source, targets);
  expect(preview.source).toBe(source);
  expect(preview.changed).toBe(false);
  expect(preview.findings[0]?.reason).toContain("Anchored");
});

test("exposes changed jobs, retained selections and static needs edges", () => {
  const source = `on: push
jobs:
  build:
    runs-on: ubuntu-24.04-arm
  tests:
    needs: build
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-24.04-arm, windows-latest]
  hosted:
    needs: [build, tests]
    runs-on: ubuntu-latest
  reusable:
    needs: hosted
    uses: owner/repo/.github/workflows/reusable.yml@main
  dynamic:
    needs: \${{ inputs.dependencies }}
    runs-on: \${{ inputs.runner }}
`;
  const preview = previewMigration(source, targets);
  expect(preview.jobs).toEqual([
    { job: "build", changed: true, needs: [], reasons: [] },
    {
      job: "tests",
      changed: true,
      needs: ["build"],
      reasons: ["No migration target configured for windows-latest."],
    },
    {
      job: "hosted",
      changed: false,
      needs: ["build", "tests"],
      reasons: ["No migration target configured for ubuntu-latest."],
    },
    {
      job: "reusable",
      changed: false,
      needs: ["hosted"],
      reasons: ["Reusable workflow requires review in its owning repository."],
    },
    {
      job: "dynamic",
      changed: false,
      reasons: ["Dynamic runner expression requires manual review."],
    },
  ]);
});

test("preserves offsets around Unicode and replaces an escaped double-quoted label", () => {
  const source =
    'name: "Build \u{1f9ea}"\non: push\njobs:\n  build:\n    runs-on: "ubuntu-24.04-\\u0061rm"\n';
  const preview = previewMigration(source, targets);
  expect(preview.changed).toBe(true);
  expect(preview.source).toBe(source.replace('"ubuntu-24.04-\\u0061rm"', '"vectis-linux-arm64"'));
});

test("refuses anchored jobs without changing jobs that alias them", () => {
  const source = `on: push
jobs:
  shared: &job
    runs-on: ubuntu-24.04-arm
  alias: *job
  safe:
    runs-on: ubuntu-24.04-arm
`;
  const preview = previewMigration(source, targets);
  expect(preview.source).toBe(
    source.replace(
      "safe:\n    runs-on: ubuntu-24.04-arm",
      "safe:\n    runs-on: vectis-linux-arm64",
    ),
  );
  expect(preview.jobs).toEqual([
    { job: "shared", changed: false, needs: [], reasons: ["Anchored job requires manual review."] },
    { job: "alias", changed: false, reasons: ["Non-mapping job requires manual review."] },
    { job: "safe", changed: true, needs: [], reasons: [] },
  ]);
});
