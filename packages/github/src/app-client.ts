import { createPrivateKey, sign } from "node:crypto";
import { Schema } from "effect";

const Installation = Schema.Struct({
  id: Schema.Int,
  app_id: Schema.Int,
  account: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  suspended_at: Schema.NullOr(Schema.String),
});
const AccessToken = Schema.Struct({ token: Schema.NonEmptyString });
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
  async repositoryToken(input: {
    owner: string;
    repo: string;
    repositoryId?: number;
    githubUserId: number;
    purpose?: "runners" | "jobs";
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
      await this.request(jwt, `${path}/installation`),
    );
    if (
      installation.app_id !== this.app.appId ||
      installation.account.type !== "User" ||
      installation.account.id !== input.githubUserId ||
      installation.suspended_at !== null
    )
      throw new Error(
        "This runner path requires an active installation owned by the verified personal GitHub account.",
      );
    const { token } = Schema.decodeUnknownSync(AccessToken)(
      await this.request(jwt, `/app/installations/${installation.id}/access_tokens`, {
        ...(input.repositoryId === undefined
          ? { repositories: [input.repo] }
          : { repository_ids: [input.repositoryId] }),
        permissions:
          input.purpose === "jobs"
            ? { actions: "read", metadata: "read" }
            : { administration: "write", metadata: "read" },
      }),
    );
    const repository = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.Int,
        private: Schema.Boolean,
        owner: Schema.Struct({ id: Schema.Int }),
      }),
    )(await this.request(token, path));
    if (
      (input.repositoryId !== undefined && repository.id !== input.repositoryId) ||
      repository.owner.id !== input.githubUserId ||
      !repository.private
    )
      throw new Error("This runner path requires a verified private personal repository.");
    return { token, path, installationId: installation.id, repositoryId: repository.id };
  }
}
