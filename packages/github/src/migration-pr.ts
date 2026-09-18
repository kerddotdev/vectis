import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";

const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const reference = Schema.Struct({ object: Schema.Struct({ sha }) });
const commit = Schema.Struct({
  tree: Schema.Struct({ sha }),
  parents: Schema.Array(Schema.Struct({ sha })),
  message: Schema.String,
});
const pull = Schema.Struct({
  number: Schema.Int,
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  head: Schema.Struct({ repo: Schema.NullOr(Schema.Struct({ id: Schema.Int })) }),
});
const repository = Schema.Struct({ id: Schema.Int, default_branch: Schema.String });
const branch = "vectis/migrate-workflows";

export interface MigrationPublication {
  readonly repositoryId: number;
  readonly owner: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly files: readonly { path: string; content: string; mode: "100644" | "100755" }[];
  readonly body: string;
}

class GitHubFailure extends VectisError {
  constructor(readonly status: number) {
    super(
      "github_request_failed",
      `GitHub returned HTTP ${status}.`,
      "Check the App installation, repository permissions and rate limits, then retry the same migration.",
    );
  }
}

// The cloud caller must verify repository authority, runner readiness and fork policy before publication.
export async function publishMigration(
  plan: MigrationPublication,
  installationToken: string,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (
    !Number.isSafeInteger(plan.repositoryId) ||
    plan.repositoryId < 1 ||
    !/^[A-Za-z0-9_.-]+$/.test(plan.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(plan.repository) ||
    !/^[a-f0-9]{40}$/.test(plan.baseCommit) ||
    !plan.baseBranch ||
    plan.baseBranch === branch ||
    plan.files.length === 0 ||
    plan.files.length > 100 ||
    new Set(plan.files.map((file) => file.path)).size !== plan.files.length ||
    plan.files.some(
      (file) =>
        !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(file.path) ||
        !["100644", "100755"].includes(file.mode),
    ) ||
    new TextEncoder().encode(JSON.stringify(plan)).length > 1024 * 1024
  )
    throw new VectisError(
      "invalid_migration",
      "The publication must contain a bounded, unique set of workflow files and a pinned base commit.",
    );
  const root = `/repos/${encodeURIComponent(plan.owner)}/${encodeURIComponent(plan.repository)}`;
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await transport(`https://api.github.com${root}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${installationToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubFailure(response.status);
    }
    if (!response.body)
      throw new VectisError("github_invalid_response", "GitHub returned an empty response.");
    const reader = response.body.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024)
          throw new VectisError(
            "github_response_too_large",
            "GitHub returned an oversized response.",
          );
        parts.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const repo = Schema.decodeUnknownSync(repository)(await request(""));
  if (repo.id !== plan.repositoryId || repo.default_branch !== plan.baseBranch)
    throw new VectisError(
      "repository_changed",
      "The repository identity or default branch changed. Prepare a new preview.",
    );
  async function existingPull() {
    const query = new URLSearchParams({
      state: "all",
      head: `${plan.owner}:${branch}`,
      per_page: "100",
    });
    const pulls = Schema.decodeUnknownSync(Schema.Array(pull))(await request(`/pulls?${query}`));
    return pulls.find((item) => item.head.repo?.id === plan.repositoryId);
  }
  function result(item: typeof pull.Type, status: "created" | "existing") {
    const url = new URL(item.html_url);
    if (url.origin !== "https://github.com" || item.head.repo?.id !== plan.repositoryId)
      throw new VectisError(
        "github_invalid_response",
        "GitHub returned an unexpected pull request URL.",
      );
    return { status, state: item.state, number: item.number, url: item.html_url };
  }
  const existing = await existingPull();
  if (existing) return result(existing, "existing");
  async function checkBase() {
    const current = Schema.decodeUnknownSync(reference)(
      await request(`/git/ref/heads/${encodeURIComponent(plan.baseBranch)}`),
    );
    if (current.object.sha !== plan.baseCommit)
      throw new VectisError(
        "migration_stale",
        "The default branch changed since this preview. Prepare a new preview before publishing.",
      );
  }
  await checkBase();
  const base = Schema.decodeUnknownSync(commit)(await request(`/git/commits/${plan.baseCommit}`));
  const tree = Schema.decodeUnknownSync(Schema.Struct({ sha }))(
    await request("/git/trees", {
      base_tree: base.tree.sha,
      tree: plan.files.map((file) => ({
        path: file.path,
        content: file.content,
        mode: file.mode,
        type: "blob",
      })),
    }),
  );
  const marker = `Migrate workflows to Vectis (${tree.sha})`;
  async function branchHead() {
    try {
      return Schema.decodeUnknownSync(reference)(await request(`/git/ref/heads/${branch}`)).object
        .sha;
    } catch (error) {
      if (error instanceof GitHubFailure && error.status === 404) return undefined;
      throw error;
    }
  }
  async function validateHead(head: string) {
    const value = Schema.decodeUnknownSync(commit)(await request(`/git/commits/${head}`));
    if (
      value.tree.sha !== tree.sha ||
      value.message !== marker ||
      value.parents.length !== 1 ||
      value.parents[0]?.sha !== plan.baseCommit
    )
      throw new VectisError(
        "migration_branch_conflict",
        "The migration branch contains different changes and was left untouched.",
        "Review the existing branch before preparing another migration.",
      );
  }
  let head = await branchHead();
  if (!head) {
    const created = Schema.decodeUnknownSync(Schema.Struct({ sha }))(
      await request("/git/commits", {
        message: marker,
        tree: tree.sha,
        parents: [plan.baseCommit],
      }),
    );
    try {
      await request("/git/refs", { ref: `refs/heads/${branch}`, sha: created.sha });
      head = created.sha;
    } catch (error) {
      head = await branchHead();
      if (!head) throw error;
    }
  }
  await validateHead(head);
  await checkBase();
  if ((await branchHead()) !== head)
    throw new VectisError(
      "migration_branch_conflict",
      "The migration branch changed during publication. Review it before retrying.",
    );
  try {
    const created = Schema.decodeUnknownSync(pull)(
      await request("/pulls", {
        title: "Run workflows on Vectis",
        head: branch,
        base: plan.baseBranch,
        body: plan.body,
        draft: false,
      }),
    );
    return result(created, "created");
  } catch (error) {
    const raced = await existingPull();
    if (raced) return result(raced, "existing");
    throw error;
  }
}
