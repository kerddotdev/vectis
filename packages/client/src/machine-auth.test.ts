import { afterEach, expect, test, vi } from "vitest";
import { credentialAccount, machineEndpoint, machineTokenFetcher } from "./machine-auth.js";

afterEach(() => vi.unstubAllGlobals());
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

test("token reuse, forced refresh and revocation do not leak a stale token", async () => {
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
  expect(await fetchToken({ forceRefreshToken: true })).toBe(null);
  expect(get).toHaveBeenCalledWith(credentialAccount(connection));
  expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});
