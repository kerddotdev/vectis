import { expect, test } from "vitest";
import { publishMigration, type MigrationPublication } from "./migration-pr.js";

const base = "a".repeat(40);
const tree = "b".repeat(40);
const head = "c".repeat(40);
const plan: MigrationPublication = {
  repositoryId: 42,
  owner: "owner",
  repository: "demo",
  baseBranch: "main",
  baseCommit: base,
  files: [{ path: ".github/workflows/ci.yml", mode: "100644", content: "# preserved\njobs: {}\n" }],
  body: "Move the verified ARM64 jobs to the prepared local environment.",
};
function fixture(
  options: {
    stale?: boolean;
    conflict?: boolean;
    race?: boolean;
    lostPullResponse?: boolean;
    wrongRepository?: boolean;
    closedPull?: boolean;
  } = {},
) {
  const requests: { method: string; path: string; body: string | undefined }[] = [];
  let branchExists = Boolean(options.conflict);
  let pullExists = Boolean(options.closedPull);
  const pr = {
    number: 1,
    state: options.closedPull ? "closed" : "open",
    html_url: "https://github.com/owner/demo/pull/1",
    head: { repo: { id: 42 } },
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/repos/owner/demo", "");
    const method = init?.method ?? "GET";
    requests.push({ method, path, body: typeof init?.body === "string" ? init.body : undefined });
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("error");
    if (method === "GET" && path === "")
      return Response.json({ id: options.wrongRepository ? 7 : 42, default_branch: "main" });
    if (method === "GET" && path === "/pulls") return Response.json(pullExists ? [pr] : []);
    if (path === "/git/ref/heads/main")
      return Response.json({ object: { sha: options.stale ? head : base } });
    if (method === "GET" && path === `/git/commits/${base}`)
      return Response.json({ tree: { sha: base }, parents: [], message: "base" });
    if (method === "POST" && path === "/git/trees") return Response.json({ sha: tree });
    if (method === "POST" && path === "/git/commits") return Response.json({ sha: head });
    if (method === "POST" && path === "/git/refs") {
      branchExists = true;
      return Response.json({}, { status: options.race ? 422 : 201 });
    }
    if (path === "/git/ref/heads/vectis/migrate-workflows")
      return Response.json({ object: { sha: head } }, { status: branchExists ? 200 : 404 });
    if (method === "GET" && path === `/git/commits/${head}`)
      return Response.json({
        tree: { sha: tree },
        parents: [{ sha: base }],
        message: options.conflict ? "Maintainer changes" : `Migrate workflows to Vectis (${tree})`,
      });
    if (method === "POST" && path === "/pulls") {
      pullExists = true;
      if (options.lostPullResponse) throw new Error("Connection lost after GitHub created the PR");
      return Response.json(pr);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { requests, transport };
}

test("publication preserves the base tree and retries return the same PR without new writes", async () => {
  const f = fixture();
  expect(await publishMigration(plan, "test-token", f.transport)).toMatchObject({
    status: "created",
    number: 1,
  });
  const writes = () => f.requests.filter((request) => request.method !== "GET");
  expect(JSON.parse(writes()[0]?.body ?? "null")).toEqual({
    base_tree: base,
    tree: [{ ...plan.files[0], type: "blob" }],
  });
  const count = writes().length;
  expect(await publishMigration(plan, "test-token", f.transport)).toMatchObject({
    status: "existing",
    number: 1,
  });
  expect(writes()).toHaveLength(count);
  expect(
    f.requests.some((request) => request.method === "PATCH" || request.method === "DELETE"),
  ).toBe(false);
});

for (const scenario of ["stale", "wrongRepository"] as const) {
  test(`${scenario} is rejected before any write`, async () => {
    const f = fixture({ [scenario]: true });
    await expect(publishMigration(plan, "test-token", f.transport)).rejects.toMatchObject({
      code: scenario === "stale" ? "migration_stale" : "repository_changed",
    });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });
}

test("a modified migration branch is never overwritten or made into a PR", async () => {
  const f = fixture({ conflict: true });
  await expect(publishMigration(plan, "test-token", f.transport)).rejects.toMatchObject({
    code: "migration_branch_conflict",
  });
  expect(
    f.requests.filter((request) => request.method !== "GET").map((request) => request.path),
  ).toEqual(["/git/trees"]);
});

for (const scenario of ["race", "lostPullResponse"] as const) {
  test(`${scenario} reconciles the observed GitHub state`, async () => {
    const f = fixture({ [scenario]: true });
    expect(await publishMigration(plan, "test-token", f.transport)).toMatchObject({ number: 1 });
    expect(
      f.requests.filter((request) => request.method === "POST" && request.path === "/pulls"),
    ).toHaveLength(1);
  });
}

test("publication rejects changes outside workflows before contacting GitHub", async () => {
  const f = fixture();
  await expect(
    publishMigration(
      { ...plan, files: [{ path: "README.md", mode: "100644", content: "replace" }] },
      "test-token",
      f.transport,
    ),
  ).rejects.toMatchObject({ code: "invalid_migration" });
  expect(f.requests).toHaveLength(0);
});

test("a closed migration PR is returned instead of recreating a rejected migration", async () => {
  const f = fixture({ closedPull: true });
  expect(await publishMigration(plan, "test-token", f.transport)).toMatchObject({
    status: "existing",
    state: "closed",
  });
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
