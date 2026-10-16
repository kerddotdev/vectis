import { createHash, createPrivateKey, sign } from "node:crypto";
import { Schema } from "effect";
import {
  githubRequest,
  GitHubApiError,
  GitHubPermissionError,
  GitHubRateLimitError,
} from "./api-request.js";
export {
  GitHubApiError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubUnavailableError,
  GitHubUncertainError,
} from "./api-request.js";
import { downloadJobLog } from "./job-logs.js";

import type { ReadinessCheck } from "../../protocol/src/readiness.js";

const Installation = Schema.Struct({
  id: Schema.Int,
  app_id: Schema.Int,
  account: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  suspended_at: Schema.NullOr(Schema.String),
});
const AccessToken = Schema.Struct({
  token: Schema.NonEmptyString,
  expires_at: Schema.optionalKey(Schema.String),
});
const tokens = new Map<string, { token: string; expiresAt: number }>();
const installations = new Map<
  string,
  { installation: typeof Installation.Type; expiresAt: number }
>();
const cacheLimit = 256;
function pruneCache<T extends { expiresAt: number }>(cache: Map<string, T>) {
  for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
  while (cache.size >= cacheLimit) {
    const key = cache.keys().next().value;
    if (key === undefined) break;
    cache.delete(key);
  }
}
export class GitHubApprovalError extends Error {
  readonly code;
  readonly nextStep;
  constructor(privateRepository = false) {
    super(
      privateRepository
        ? "Private runner admission requires disabled fork workflows or approval for every fork run."
        : "Public runner admission requires approval for every external contributor.",
    );
    this.code = privateRepository
      ? "private_runner_approval_required"
      : "public_runner_approval_required";
    this.nextStep = privateRepository
      ? "In GitHub repository Settings > Actions > General, disable fork pull request workflows or require approval for fork pull request workflows, then retry. Vectis never approves runs automatically."
      : "In GitHub repository Settings > Actions > General, require approval for all external contributors, then retry. Vectis never approves runs automatically.";
  }
}
export class GitHubAdminError extends Error {
  readonly code = "repository_admin_required";
  readonly nextStep =
    "Connect a verified GitHub account with current administrator access to this organization repository, then retry.";
  constructor() {
    super("Organization runners require verified repository administrator access.");
  }
}
export class GitHubInstallationError extends Error {
  readonly code = "github_app_not_installed";
  readonly nextStep =
    "Install the Vectis GitHub App on the account or organization that owns the repository from the GitHub tab on the account page, then link the account again and retry.";
  constructor(owner: string, repo: string) {
    super(
      `GitHub has no active Vectis installation for ${owner}/${repo} that the verified account can use.`,
    );
  }
}
export class GitHubAccessError extends Error {
  readonly nextStep =
    "Check repository access and the Vectis GitHub App installation, then reconnect the repository.";
  constructor(readonly code: "repository_access_denied" | "installation_changed") {
    super("This runner path requires a verified repository in the selected installation.");
  }
}
function githubReadinessFailure(id: string, error: unknown): ReadinessCheck {
  if (
    error instanceof GitHubApprovalError ||
    error instanceof GitHubAdminError ||
    error instanceof GitHubInstallationError ||
    error instanceof GitHubAccessError
  )
    return {
      id,
      status: "blocked",
      code: error.code,
      message: error.message,
      nextStep: error.nextStep,
      target: { area: "github" },
    };
  return {
    id,
    status: "unknown",
    code: error instanceof GitHubRateLimitError ? error.code : "github_unavailable",
    message: "GitHub access could not be verified.",
    nextStep: "Check GitHub availability and retry readiness.",
    target: { area: "github" },
  };
}

export function createGitHubAppJwt(app: { clientId: string; privateKey: string }) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: app.clientId, iat: now - 60, exp: now + 300 })}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), createPrivateKey(app.privateKey)).toString("base64url")}`;
}
export class GitHubAppClient {
  private readonly cacheScope: string;
  constructor(
    private readonly app: { appId: number; clientId: string; privateKey: string },
    private readonly options: { budgetMs?: number } = {},
  ) {
    if (
      options.budgetMs !== undefined &&
      (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0)
    )
      throw new Error("GitHub request budget must be positive and finite.");
    this.cacheScope = createHash("sha256").update(JSON.stringify(app)).digest("hex");
  }
  private jwt() {
    return createGitHubAppJwt(this.app);
  }
  async request(
    token: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.send(token, path, body === undefined ? "GET" : "POST", body, signal)).body;
  }
  async post(
    token: string,
    path: string,
    body: unknown,
    responseBody: "json" | "discard" = "json",
  ) {
    return this.send(token, path, "POST", body, undefined, responseBody);
  }
  async downloadJobLog(token: string, path: string, after?: number) {
    try {
      return await downloadJobLog(token, path, after);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) this.invalidateToken(token);
      throw error;
    }
  }
  private invalidateToken(token: string) {
    for (const [key, entry] of tokens) if (entry.token === token) tokens.delete(key);
    for (const key of installations.keys())
      if (key.startsWith(this.cacheScope + ":")) installations.delete(key);
  }
  async delete(token: string, path: string): Promise<void> {
    await this.send(token, path, "DELETE");
  }
  private async send(
    token: string,
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
    signal?: AbortSignal,
    responseBody: "json" | "discard" = "json",
  ): Promise<{ status: number; body: unknown }> {
    return githubRequest({
      token,
      path,
      method,
      body,
      signal,
      responseBody,
      budgetMs: this.options.budgetMs ?? 45000,
      invalidate: () => this.invalidateToken(token),
    });
  }
  private async installationToken(
    installationId: number,
    repository: { repositoryId: number } | { owner: string; repo: string },
    permissions: Record<string, "read" | "write">,
  ) {
    pruneCache(tokens);
    const key = JSON.stringify([this.cacheScope, installationId, repository, permissions]);
    const cached = tokens.get(key);
    if (cached) return cached;
    const access = Schema.decodeUnknownSync(AccessToken)(
      await this.request(this.jwt(), `/app/installations/${installationId}/access_tokens`, {
        ...("repositoryId" in repository
          ? { repository_ids: [repository.repositoryId] }
          : { repositories: [repository.repo] }),
        permissions,
      }),
    );
    const entry = {
      token: access.token,
      expiresAt: access.expires_at ? Date.parse(access.expires_at) - 300000 : 0,
    };
    if (entry.expiresAt > Date.now()) tokens.set(key, entry);
    return entry;
  }
  private async repositoryContext(input: {
    owner: string;
    repo: string;
    repositoryId?: number;
    installationId?: number;
    githubUserId: number;
    githubLogin?: string;
    purpose?:
      | "runners"
      | "cleanup"
      | "jobs"
      | "migration-read"
      | "migration-write"
      | "readiness"
      | "actions-write";
    actionsOperation?: "cancel";
  }) {
    if (
      !/^[A-Za-z0-9-]+$/.test(input.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
      input.repo === "." ||
      input.repo === ".."
    )
      throw new Error("Invalid repository name.");
    const path = `/repos/${input.owner}/${input.repo}`;
    pruneCache(installations);
    const lookupKey = `${this.cacheScope}:${path.toLowerCase()}`;
    const installation =
      installations.get(lookupKey)?.installation ??
      Schema.decodeUnknownSync(Installation)(
        await this.request(this.jwt(), `${path}/installation`).catch((error: unknown) => {
          // GitHub answers 404 both for a repository the App cannot see and for one that does not
          // exist, so the message has to cover the installation without claiming the repository.
          if (error instanceof GitHubApiError && error.status === 404)
            throw new GitHubInstallationError(input.owner, input.repo);
          throw error;
        }),
      );
    if (
      installation.app_id !== this.app.appId ||
      !["User", "Organization"].includes(installation.account.type) ||
      (installation.account.type === "User" && installation.account.id !== input.githubUserId) ||
      installation.suspended_at !== null
    )
      throw new GitHubInstallationError(input.owner, input.repo);
    if (input.installationId !== undefined && input.installationId !== installation.id)
      throw new GitHubAccessError("installation_changed");
    const { token, expiresAt } = await this.installationToken(
      installation.id,
      input.repositoryId === undefined
        ? { owner: input.owner, repo: input.repo }
        : { repositoryId: input.repositoryId },
      input.purpose === "actions-write"
        ? { actions: "write", metadata: "read" }
        : input.purpose === "jobs"
          ? { actions: "read", metadata: "read" }
          : input.purpose === "migration-read"
            ? { contents: "read", metadata: "read" }
            : input.purpose === "migration-write"
              ? {
                  contents: "write",
                  workflows: "write",
                  pull_requests: "write",
                  metadata: "read",
                }
              : {
                  administration: input.purpose === "readiness" ? "read" : "write",
                  metadata: "read",
                },
    ).catch((error: unknown) => {
      if (error instanceof GitHubRateLimitError) throw error;
      if (
        input.purpose === "actions-write" &&
        error instanceof GitHubApiError &&
        (error.status === 403 || error.status === 422)
      )
        throw new GitHubPermissionError(error.status);
      if (error instanceof GitHubApiError && [403, 404, 422].includes(error.status))
        throw new GitHubAccessError("repository_access_denied");
      throw error;
    });
    const repository = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.Int,
        private: Schema.Boolean,
        owner: Schema.Struct({ id: Schema.Int }),
      }),
    )(
      await this.request(token, path).catch((error: unknown) => {
        if (error instanceof GitHubRateLimitError) throw error;
        if (error instanceof GitHubApiError && [403, 404].includes(error.status))
          throw new GitHubAccessError("repository_access_denied");
        throw error;
      }),
    );
    if (
      (input.repositoryId !== undefined && repository.id !== input.repositoryId) ||
      repository.owner.id !== installation.account.id
    )
      throw new GitHubAccessError("repository_access_denied");
    if (expiresAt > Date.now()) installations.set(lookupKey, { installation, expiresAt });
    return { token, path, installation, repository };
  }
  private async checkAdmin(
    context: Awaited<ReturnType<GitHubAppClient["repositoryContext"]>>,
    input: Parameters<GitHubAppClient["repositoryContext"]>[0],
  ) {
    const { installation, token, path } = context;
    if (installation.account.type === "Organization") {
      if (!input.githubLogin || !/^[A-Za-z0-9-]+$/.test(input.githubLogin))
        throw new GitHubAdminError();
      const permission = Schema.decodeUnknownSync(
        Schema.Struct({ permission: Schema.String, user: Schema.Struct({ id: Schema.Int }) }),
      )(
        await this.request(token, `${path}/collaborators/${input.githubLogin}/permission`).catch(
          (error: unknown) => {
            if (error instanceof GitHubRateLimitError) throw error;
            if (error instanceof GitHubApiError && [403, 404].includes(error.status))
              throw new GitHubAdminError();
            throw error;
          },
        ),
      );
      if (permission.permission !== "admin" || permission.user.id !== input.githubUserId)
        throw new GitHubAdminError();
    }
  }
  private async checkApproval(context: Awaited<ReturnType<GitHubAppClient["repositoryContext"]>>) {
    const { repository, token, path } = context;
    if (repository.private) {
      const policy = Schema.decodeUnknownSync(
        Schema.Struct({
          run_workflows_from_fork_pull_requests: Schema.Boolean,
          require_approval_for_fork_pr_workflows: Schema.Boolean,
        }),
      )(await this.request(token, `${path}/actions/permissions/fork-pr-workflows-private-repos`));
      if (
        policy.run_workflows_from_fork_pull_requests &&
        !policy.require_approval_for_fork_pr_workflows
      )
        throw new GitHubApprovalError(true);
      return;
    }
    const policy = Schema.decodeUnknownSync(Schema.Struct({ approval_policy: Schema.String }))(
      await this.request(token, `${path}/actions/permissions/fork-pr-contributor-approval`),
    );
    if (policy.approval_policy !== "all_external_contributors") throw new GitHubApprovalError();
  }
  async repositoryToken(input: Parameters<GitHubAppClient["repositoryContext"]>[0]) {
    const context = await this.repositoryContext(input);
    if (input.purpose !== "cleanup") await this.checkAdmin(context, input);
    if (
      input.purpose === undefined ||
      input.purpose === "runners" ||
      input.purpose === "migration-write" ||
      (input.purpose === "actions-write" && input.actionsOperation !== "cancel")
    ) {
      let policyContext = context;
      // Starting runs consumes host capacity; cancellation never needs the fork approval policy.
      if (input.purpose === "migration-write" || input.purpose === "actions-write") {
        const { token } = await this.installationToken(
          context.installation.id,
          { repositoryId: context.repository.id },
          { administration: "read", metadata: "read" },
        );
        policyContext = { ...context, token };
      }
      await this.checkApproval(policyContext);
    }
    return {
      token: context.token,
      path: context.path,
      installationId: context.installation.id,
      repositoryId: context.repository.id,
    };
  }
  async repositoryReadiness(
    input: Parameters<GitHubAppClient["repositoryContext"]>[0],
  ): Promise<ReadinessCheck[]> {
    let context: Awaited<ReturnType<GitHubAppClient["repositoryContext"]>>;
    try {
      context = await this.repositoryContext({ ...input, purpose: "readiness" });
    } catch (error) {
      return [
        githubReadinessFailure("github.app", error),
        ...["github.admin", "github.approval"].map((id): ReadinessCheck => ({
          id,
          status: "unknown",
          message: "Repository policy cannot be read until GitHub App access is verified.",
          nextStep: "Resolve the GitHub App access check, then retry.",
          target: { area: "github" },
        })),
      ];
    }
    const checks: ReadinessCheck[] = [
      { id: "github.app", status: "ok", message: "The GitHub App can access this repository." },
    ];
    for (const [id, check] of [
      ["github.admin", () => this.checkAdmin(context, input)],
      ["github.approval", () => this.checkApproval(context)],
    ] as const) {
      try {
        await check();
        checks.push({
          id,
          status: "ok",
          message:
            id === "github.admin"
              ? `GitHub account ${input.githubLogin ?? input.githubUserId} satisfies repository administrator requirements.`
              : "The repository satisfies external contributor approval requirements.",
        });
      } catch (error) {
        checks.push(githubReadinessFailure(id, error));
      }
    }
    return checks;
  }
}
