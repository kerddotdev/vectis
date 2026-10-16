import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitHubAppClient, GitHubUncertainError } from "./app-client.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
function client(budgetMs = 45000) {
  return new GitHubAppClient(
    { appId: 42, clientId: expect.getState().currentTestName ?? "test", privateKey },
    { budgetMs },
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected fetch");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function complete<T>(request: Promise<T>): Promise<T> {
  const settled = request.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

test.each([500, 502, 503, 504])("retries %s with jitter then succeeds", async (status) => {
  const start = Date.now();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client().request("token", "/test"))).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(Date.now() - start).toBe(250);
});

test("honors retry-after on 429", async () => {
  const start = Date.now();
  const times: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      times.push(Date.now());
      return times.length === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ ok: true });
    }),
  );
  await expect(complete(client().request("token", "/test"))).resolves.toEqual({ ok: true });
  expect(times).toEqual([start, start + 2000]);
});

test("honors the later of rate-limit reset and retry-after on 403", async () => {
  const start = Date.now();
  const times: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      times.push(Date.now());
      return times.length === 1
        ? Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(start / 1000 + 3),
                "retry-after": "1",
              },
            },
          )
        : Response.json({ ok: true });
    }),
  );
  await complete(client().request("token", "/test"));
  expect(times).toEqual([start, start + 3000]);
});

test("fails immediately when a rate-limit wait would exhaust the budget", async () => {
  const start = Date.now();
  const fetch = vi.fn(async () =>
    Response.json(
      { message: "Resource not accessible by integration" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(start / 1000 + 90),
        },
      },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client().request("token", "/test"))).rejects.toMatchObject({
    code: "github_rate_limited",
    status: 403,
    resetAt: start + 90000,
  });
  expect(Date.now()).toBe(start);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("secondary limits without timing headers require at least a minute", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client().request("token", "/test"))).rejects.toMatchObject({
    code: "github_rate_limited",
    status: 403,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["network", "timeout", 502] as const)(
  "jitconfig POST is uncertain after %s and is never retried",
  async (failure) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (failure === "network") throw new TypeError("connection lost, private token");
      if (failure === "timeout")
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      return new Response(null, { status: failure });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      complete(
        client().request("token", "/repos/owner/repo/actions/runners/generate-jitconfig", {}),
      ),
    ).rejects.toBeInstanceOf(GitHubUncertainError);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each(["cancel", "rerun", "dispatches"])(
  "does not retry the %s POST on rate limit",
  async (endpoint) => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "1" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      complete(client().post("token", `/repos/owner/repo/actions/${endpoint}`, {})),
    ).rejects.toMatchObject({ code: "github_rate_limited", status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("retries network errors with exponential full jitter and stops at four attempts", async () => {
  const start = Date.now();
  const times: number[] = [];
  const fetch = vi.fn(async () => {
    times.push(Date.now());
    throw new TypeError("private network diagnostic");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client().request("token", "/test"))).rejects.toMatchObject({
    code: "github_unavailable",
    status: 0,
    message: "GitHub is temporarily unavailable.",
  });
  expect(times.map((time) => time - start)).toEqual([0, 250, 750, 1750]);
});

test("a network failure can recover", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("connection reset"))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client().request("token", "/test"))).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("request timeouts remain 15 seconds and the last attempt cannot exceed the total budget", async () => {
  const start = Date.now();
  const fetch = vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(complete(client(20000).request("token", "/test"))).rejects.toMatchObject({
    code: "github_unavailable",
    status: 0,
  });
  expect(Date.now() - start).toBe(20000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("an abort during backoff stops retries and releases its timer", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  const assertion = expect(
    client().request("token", "/test", undefined, abort.signal),
  ).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(100);
  abort.abort(new Error("cancelled"));
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("DELETE and installation token POST are safe to retry", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ token: "new" }));
  vi.stubGlobal("fetch", fetch);
  await complete(client().delete("token", "/repos/owner/repo/actions/runners/1"));
  await expect(
    complete(client().request("jwt", "/app/installations/1/access_tokens", {})),
  ).resolves.toEqual({ token: "new" });
  expect(fetch).toHaveBeenCalledTimes(4);
});

function tokenFixture() {
  let count = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 10,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens"))
      return Response.json({
        token: `token-${++count}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    return Response.json({ id: 123, private: true, owner: { id: 7 } });
  });
  vi.stubGlobal("fetch", fetch);
  const input = {
    owner: "owner",
    repo: "repo",
    repositoryId: 123,
    installationId: 10,
    githubUserId: 7,
    purpose: "jobs" as const,
  };
  return { fetch, input, count: () => count };
}

test("installation tokens and lookup are reused across clients until five minutes before expiry", async () => {
  const { fetch, input, count } = tokenFixture();
  expect((await client().repositoryToken(input)).token).toBe("token-1");
  await vi.advanceTimersByTimeAsync(3299999);
  expect((await client().repositoryToken(input)).token).toBe("token-1");
  expect(count()).toBe(1);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/installation"))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await client().repositoryToken(input)).token).toBe("token-2");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/installation"))).toHaveLength(2);
});

test("cached access never crosses repository, permission or App boundaries", async () => {
  const { input, count } = tokenFixture();
  await client().repositoryToken(input);
  await client().repositoryToken({ ...input, purpose: "cleanup" });
  await expect(client().repositoryToken({ ...input, repositoryId: 999 })).rejects.toMatchObject({
    code: "repository_access_denied",
  });
  await new GitHubAppClient({ appId: 42, clientId: "other-app", privateKey }).repositoryToken(
    input,
  );
  expect(count()).toBe(4);
  await expect(client().repositoryToken({ ...input, githubUserId: 8 })).rejects.toMatchObject({
    code: "github_app_not_installed",
  });
});

test.each(["request", "logs"])(
  "401 from %s invalidates a reused token and its installation lookup",
  async (source) => {
    const { fetch, input, count } = tokenFixture();
    const access = await client().repositoryToken(input);
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      source === "request"
        ? client().request(access.token, "/test")
        : client().downloadJobLog(access.token, "/repos/owner/repo/actions/jobs/4/logs"),
    ).rejects.toMatchObject({ status: 401 });
    expect((await client().repositoryToken(input)).token).toBe("token-2");
    expect(count()).toBe(2);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/installation"))).toHaveLength(2);
  },
);

test("rate-limit 403 during token minting is not reported as a permission failure", async () => {
  const { fetch, input } = tokenFixture();
  fetch.mockImplementation(async (url: string) =>
    url.endsWith("/installation")
      ? Response.json({ id: 10, app_id: 42, account: { id: 7, type: "User" }, suspended_at: null })
      : new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
        }),
  );
  await expect(
    complete(client().repositoryToken({ ...input, purpose: "actions-write" })),
  ).rejects.toMatchObject({ code: "github_rate_limited", status: 403 });
});
