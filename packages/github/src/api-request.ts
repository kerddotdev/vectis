export class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API request failed (${status}).`);
  }
}

export class GitHubUnavailableError extends GitHubApiError {
  readonly code = "github_unavailable";
  readonly nextStep = "Check GitHub availability and retry.";
  constructor(status = 0) {
    super(status);
    this.message = "GitHub is temporarily unavailable.";
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  readonly code = "github_rate_limited";
  readonly nextStep = "Wait for the GitHub rate limit to reset, then retry.";
  constructor(
    status: number,
    readonly resetAt?: number,
  ) {
    super(status);
    this.message = "GitHub API rate limit exceeded.";
  }
}

export class GitHubUncertainError extends GitHubApiError {
  constructor(status = 0) {
    super(status);
    this.message = "The GitHub request outcome could not be confirmed.";
  }
}

export class GitHubPermissionError extends GitHubApiError {
  readonly code = "github_app_permission_required";
  readonly nextStep =
    "Approve the updated Vectis GitHub App permissions on GitHub (Settings -> Applications), then retry.";
  constructor(status = 403) {
    super(status);
    this.message = "The Vectis GitHub App needs updated Actions write permission.";
  }
}

type Method = "GET" | "HEAD" | "DELETE" | "PUT" | "POST";
type Result = { status: number; body: unknown };

function wait(delay: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function readText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("GitHub response exceeded its limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerTime(headers: Headers, name: string, multiplier: number) {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * multiplier : undefined;
}

export async function githubRequest(input: {
  token: string;
  path: string;
  method: Method;
  body?: unknown;
  signal?: AbortSignal | undefined;
  responseBody: "json" | "discard";
  budgetMs: number;
  invalidate: () => void;
}): Promise<Result> {
  const { token, path, method, body, signal, responseBody } = input;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
    throw new Error("Invalid GitHub API path.");
  const safe = method !== "POST" || /^\/app\/installations\/\d+\/access_tokens$/.test(path);
  const deadline = Date.now() + input.budgetMs;
  let failure: GitHubUnavailableError | GitHubRateLimitError = new GitHubUnavailableError();
  for (let attempt = 0; attempt < 4; attempt++) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(15000, remaining));
    let response: Response | undefined;
    let text = "";
    let read = false;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
      });
      if (response.status === 401) input.invalidate();
      if (response.ok && (responseBody === "discard" || method === "HEAD")) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, body: null };
      }
      text = await readText(response);
      read = true;
    } catch (error) {
      signal?.throwIfAborted();
      if (!safe) throw new GitHubUncertainError(response?.status);
      if (
        response &&
        !response.ok &&
        response.status < 500 &&
        ![403, 429].includes(response.status)
      )
        throw new GitHubApiError(response.status);
      if (
        response?.ok &&
        error instanceof Error &&
        error.message === "GitHub response exceeded its limit."
      )
        throw error;
      failure = new GitHubUnavailableError(response?.status);
    } finally {
      clearTimeout(timer);
    }
    let requiredWait = 0;
    if (response && !response.ok) {
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            /secondary rate limit/i.test(text)));
      const retryAfter = headerTime(response.headers, "retry-after", 1000);
      const reset = headerTime(response.headers, "x-ratelimit-reset", 1000);
      const resetAt = Math.max(retryAfter === undefined ? 0 : Date.now() + retryAfter, reset ?? 0);
      requiredWait = Math.max(retryAfter ?? 0, (reset ?? 0) - Date.now());
      if (rateLimited) {
        failure = new GitHubRateLimitError(response.status, resetAt || undefined);
        if (retryAfter === undefined && reset === undefined) requiredWait = 60000 * 2 ** attempt;
      } else if (response.status >= 500) {
        if (!safe) throw new GitHubUncertainError(response.status);
        failure = new GitHubUnavailableError(response.status);
        if (![500, 502, 503, 504].includes(response.status)) throw failure;
      } else if (
        response.status === 403 &&
        text.includes("Resource not accessible by integration")
      ) {
        throw new GitHubPermissionError();
      } else throw new GitHubApiError(response.status);
    } else if (response?.ok && read) {
      if (!response.body && ![201, 202, 204].includes(response.status))
        throw new Error("GitHub returned no response body.");
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    if (!safe || attempt === 3) throw failure;
    const delay = Math.max(requiredWait, Math.random() * 500 * 2 ** attempt);
    if (delay >= deadline - Date.now()) throw failure;
    await wait(delay, signal);
  }
  throw failure;
}
