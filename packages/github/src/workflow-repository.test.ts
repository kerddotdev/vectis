import { expect, test } from "vitest";
import { readRepositoryWorkflows } from "./workflow-repository.js";
const sha = (n: number) => String(n).repeat(40);
function fixture(options: { truncated?: boolean; mode?: string; wrongBlob?: boolean } = {}) {
  const paths: string[] = [];
  const source = "# Preserve this comment\njobs: {}\n";
  const read = async (path: string) => {
    paths.push(path);
    if (path === "") return { id: 7, default_branch: "main" };
    if (path === "/git/ref/heads/main") return { object: { sha: sha(1) } };
    if (path === `/git/commits/${sha(1)}`) return { tree: { sha: sha(2) } };
    const entries =
      path === `/git/trees/${sha(2)}`
        ? [{ path: ".github", mode: "040000", type: "tree", sha: sha(3) }]
        : path === `/git/trees/${sha(3)}`
          ? [{ path: "workflows", mode: "040000", type: "tree", sha: sha(4) }]
          : [{ path: "ci.yml", mode: options.mode ?? "100644", type: "blob", sha: sha(5) }];
    if (path.startsWith("/git/trees/"))
      return { truncated: options.truncated ?? false, tree: entries };
    return {
      sha: options.wrongBlob ? sha(6) : sha(5),
      encoding: "base64",
      content: Buffer.from(source).toString("base64"),
      size: Buffer.byteLength(source),
    };
  };
  return { read, paths, source };
}
test("reads only workflow blobs from a pinned default-branch commit", async () => {
  const f = fixture();
  expect(await readRepositoryWorkflows(f.read, 7)).toEqual({
    baseBranch: "main",
    baseCommit: sha(1),
    files: [{ path: ".github/workflows/ci.yml", mode: "100644", source: f.source }],
  });
  expect(f.paths).toHaveLength(7);
});
for (const options of [{ truncated: true }, { mode: "120000" }, { wrongBlob: true }])
  test(`rejects incomplete or unsafe workflow contents ${JSON.stringify(options)}`, async () => {
    await expect(readRepositoryWorkflows(fixture(options).read, 7)).rejects.toThrow();
  });
test("repository identity changes prevent reading workflow contents", async () => {
  const f = fixture();
  await expect(readRepositoryWorkflows(f.read, 99)).rejects.toThrow("identity");
  expect(f.paths).toEqual([""]);
});
