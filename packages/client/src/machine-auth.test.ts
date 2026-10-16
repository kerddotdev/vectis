import { afterEach, expect, test, vi } from "vitest";
import { credentialAccount, machineEndpoint, machineTokenFetcher } from "./machine-auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const connection = {
  deploymentUrl: "https://example-123.convex.cloud",
  machineId: "machine",
  localId: "host",
};

test("credentials are bound to a canonical deployment and machine", () => {
  expect(machineEndpoint(connection.deploymentUrl)).toBe(
    "https://example-123.convex.site/machine/token",
  );
  for (const url of [
    "http://example-123.convex.cloud",
    "https://example-123.convex.cloud.attacker.test",
    "https://example-123.convex.cloud/path",
    "https://user@example-123.convex.cloud",
  ])
    expect(() => machineEndpoint(url)).toThrow();
  expect(credentialAccount(connection)).not.toBe(
    credentialAccount({ ...connection, machineId: "another" }),
  );
});

test("token reuse, forced refresh and removal do not leak a stale token", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "first", expiresAt: Date.now() + 300000 }))
    .mockResolvedValueOnce(Response.json({ token: "second", expiresAt: Date.now() + 300000 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", request);
  const get = vi.fn(async () => "secret");
  const fetchToken = machineTokenFetcher(connection, { get }, new AbortController().signal);
  expect(await fetchToken({ forceRefreshToken: false })).toBe("first");
  expect(await fetchToken({ forceRefreshToken: false })).toBe("first");
  expect(request).toHaveBeenCalledTimes(1);
  expect(await fetchToken({ forceRefreshToken: true })).toBe("second");
  await expect(fetchToken({ forceRefreshToken: true })).rejects.toMatchObject({
    code: "machine_rejected",
  });
  expect(get).toHaveBeenCalledWith(credentialAccount(connection), expect.any(AbortSignal));
  expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});

test.each(["fresh", "original"])(
  "forced refresh retries an identical token once and returns %s",
  async (retriedToken) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "original", expiresAt: Date.now() + 300000 }))
      .mockResolvedValueOnce(Response.json({ token: "original", expiresAt: Date.now() + 300000 }))
      .mockResolvedValueOnce(
        Response.json({ token: retriedToken, expiresAt: Date.now() + 300000 }),
      );
    vi.stubGlobal("fetch", request);
    const fetchToken = machineTokenFetcher(
      connection,
      { get: async () => "secret" },
      new AbortController().signal,
    );
    expect(await fetchToken({ forceRefreshToken: false })).toBe("original");
    const refreshed = fetchToken({ forceRefreshToken: true });
    const resolved = vi.fn();
    void refreshed.then(resolved);
    await vi.advanceTimersByTimeAsync(1099);
    expect(request).toHaveBeenCalledTimes(2);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalledWith(retriedToken);
    expect(await refreshed).toBe(retriedToken);
    expect(request).toHaveBeenCalledTimes(3);
    expect(await fetchToken({ forceRefreshToken: false })).toBe(retriedToken);
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("cancelling an identical-token retry releases its timer without another request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ token: "original", expiresAt: Date.now() + 300000 })),
  );
  const abort = new AbortController();
  const fetchToken = machineTokenFetcher(connection, { get: async () => "secret" }, abort.signal);
  await fetchToken({ forceRefreshToken: false });
  const refreshed = fetchToken({ forceRefreshToken: true });
  const rejected = expect(refreshed).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(500);
  abort.abort();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("a rejected retry clears the cached token and preserves the removal error", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "original", expiresAt: Date.now() + 300000 }))
    .mockResolvedValueOnce(Response.json({ token: "original", expiresAt: Date.now() + 300000 }))
    .mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", request);
  const fetchToken = machineTokenFetcher(
    connection,
    { get: async () => "secret" },
    new AbortController().signal,
  );
  await fetchToken({ forceRefreshToken: false });
  const rejected = expect(fetchToken({ forceRefreshToken: true })).rejects.toMatchObject({
    code: "machine_rejected",
  });
  await vi.advanceTimersByTimeAsync(1100);
  await rejected;
  await expect(fetchToken({ forceRefreshToken: false })).rejects.toMatchObject({
    code: "machine_rejected",
  });
  expect(request).toHaveBeenCalledTimes(4);
});
