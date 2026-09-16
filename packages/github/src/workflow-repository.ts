import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Tree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, mode: Schema.String, type: Schema.String, sha: Sha }),
  ),
});
const Blob = Schema.Struct({
  sha: Sha,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
  size: Schema.Int,
});

export async function readRepositoryWorkflows(
  read: (path: string) => Promise<unknown>,
  repositoryId: number,
) {
  const repo = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.Int, default_branch: Schema.NonEmptyString }),
  )(await read(""));
  if (repo.id !== repositoryId)
    throw new VectisError("repository_changed", "The repository identity changed.");
  const reference = Schema.decodeUnknownSync(
    Schema.Struct({ object: Schema.Struct({ sha: Sha }) }),
  )(await read(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`));
  const baseCommit = reference.object.sha;
  const commit = Schema.decodeUnknownSync(Schema.Struct({ tree: Schema.Struct({ sha: Sha }) }))(
    await read(`/git/commits/${baseCommit}`),
  );
  async function tree(id: string) {
    const value = Schema.decodeUnknownSync(Tree)(await read(`/git/trees/${id}`));
    if (value.truncated)
      throw new VectisError(
        "workflow_inventory_incomplete",
        "GitHub returned a truncated workflow directory.",
      );
    return value.tree;
  }
  let treeId = commit.tree.sha;
  const files: { path: string; source: string; mode: "100644" | "100755" }[] = [];
  for (const name of [".github", "workflows"]) {
    const entry = (await tree(treeId)).find((item) => item.path === name);
    if (!entry) return { baseBranch: repo.default_branch, baseCommit, files };
    if (entry.type !== "tree")
      throw new VectisError(
        "invalid_workflow_directory",
        "Workflow directories must be regular Git trees.",
      );
    treeId = entry.sha;
  }
  const entries = (await tree(treeId)).filter((item) => /\.ya?ml$/.test(item.path));
  if (entries.length > 100)
    throw new VectisError(
      "workflow_inventory_too_large",
      "At most 100 workflow files can be inspected together.",
    );
  let size = 0;
  for (const entry of entries) {
    if (
      !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(entry.path) ||
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    )
      throw new VectisError(
        "unsupported_workflow_file",
        "Workflow migration requires regular YAML files with portable names.",
      );
    const blob = Schema.decodeUnknownSync(Blob)(await read(`/git/blobs/${entry.sha}`));
    const bytes = Buffer.from(blob.content, "base64");
    size += bytes.length;
    const source = bytes.toString("utf8");
    if (
      blob.sha !== entry.sha ||
      bytes.length !== blob.size ||
      size > 512 * 1024 ||
      !Buffer.from(source, "utf8").equals(bytes)
    )
      throw new VectisError(
        "invalid_workflow_content",
        "Workflow contents must be verified UTF-8 within the 512 KiB repository limit.",
      );
    files.push({ path: `.github/workflows/${entry.path}`, source, mode: entry.mode });
  }
  return { baseBranch: repo.default_branch, baseCommit, files };
}
