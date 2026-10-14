import { createPrivateKey, sign } from "node:crypto";
import { Schema } from "effect";

import type { ReadinessCheck } from "../../protocol/src/readiness.js";

const Installation = Schema.Struct({
  id: Schema.Int,
  app_id: Schema.Int,
  account: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  suspended_at: Schema.NullOr(Schema.String),
});
const AccessToken = Schema.Struct({ token: Schema.NonEmptyString });
export class GitHubApprovalError extends Error {
  readonly code = "public_runner_approval_required";
  readonly nextStep =
    "In GitHub repository Settings > Actions > General, require approval for all external contributors, then retry. Vectis never approves runs automatically.";
  constructor() {
    super("Public runner admission requires approval for every external contributor.");
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
    code: "github_unavailable",
    message: "GitHub access could not be verified.",
    nextStep: "Check GitHub availability and retry readiness.",
    target: { area: "github" },
  };
}

export class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API request failed (${status}).`);
  }
}
export class GitHubAppClient {
  constructor(private readonly app: { appId: number; clientId: string; privateKey: string }) {}
  private jwt() {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.app.clientId, iat: now - 60, exp: now + 300 })}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), createPrivateKey(this.app.privateKey)).toString("base64url")}`;
  }
  async request(token: string, path: string, body?: unknown): Promise<unknown> {
    return this.send(token, path, body === undefined ? "GET" : "POST", body);
  }
  async delete(token: string, path: string): Promise<void> {
    await this.send(token, path, "DELETE");
  }
  private async send(
    token: string,
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid GitHub API path.");
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubApiError(response.status);
    }
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("GitHub returned no response body.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error("GitHub response exceeded its limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async repositoryContext(input: {
    owner: string;
    repo: string;
    repositoryId?: number;
    installationId?: number;
    githubUserId: number;
    githubLogin?: string;
    purpose?: "runners" | "cleanup" | "jobs" | "migration-read" | "migration-write" | "readiness";
  }) {
    if (
      !/^[A-Za-z0-9-]+$/.test(input.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
      input.repo === "." ||
      input.repo === ".."
    )
      throw new Error("Invalid repository name.");
    const path = `/repos/${input.owner}/${input.repo}`;
    const jwt = this.jwt();
    const installation = Schema.decodeUnknownSync(Installation)(
      await this.request(jwt, `${path}/installation`).catch((error: unknown) => {
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
    const { token } = Schema.decodeUnknownSync(AccessToken)(
      await this.request(jwt, `/app/installations/${installation.id}/access_tokens`, {
        ...(input.repositoryId === undefined
          ? { repositories: [input.repo] }
          : { repository_ids: [input.repositoryId] }),
        permissions:
          input.purpose === "jobs"
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
      }).catch((error: unknown) => {
        if (error instanceof GitHubApiError && [403, 404, 422].includes(error.status))
          throw new GitHubAccessError("repository_access_denied");
        throw error;
      }),
    );
    const repository = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.Int,
        private: Schema.Boolean,
        owner: Schema.Struct({ id: Schema.Int }),
      }),
    )(
      await this.request(token, path).catch((error: unknown) => {
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
    if (repository.private) return;
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
      input.purpose === "migration-write"
    ) {
      let policyContext = context;
      if (!context.repository.private && input.purpose === "migration-write") {
        const { token } = Schema.decodeUnknownSync(AccessToken)(
          await this.request(
            this.jwt(),
            `/app/installations/${context.installation.id}/access_tokens`,
            {
              repository_ids: [context.repository.id],
              permissions: { administration: "read", metadata: "read" },
            },
          ),
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
