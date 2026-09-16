import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubAppClient } from "./app-client.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = {
  appId: 42,
  clientId: "client",
  privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};
const input = { owner: "test-owner", repo: "sandbox", repositoryId: 123, githubUserId: 7 };
afterEach(() => vi.unstubAllGlobals());
test("App authentication signs a short JWT and narrows runner access to the verified repository", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    if (url.endsWith("/installation")) {
      const [header, payload, signature] = authorization.slice(7).split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          keys.publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
      expect(claims.iss).toBe("client");
      expect(claims.exp - claims.iat).toBe(360);
      return Response.json({
        id: 10,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    }
    if (url.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [123],
        permissions: { administration: "write", metadata: "read" },
      });
      return Response.json({ token: "installation-secret" });
    }
    expect(authorization).toBe("Bearer installation-secret");
    return Response.json({ id: 123, private: true, owner: { id: 7 } });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await new GitHubAppClient(app).repositoryToken(input)).toEqual({
    token: "installation-secret",
    path: "/repos/test-owner/sandbox",
    installationId: 10,
    repositoryId: 123,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
test("foreign owners, suspended installations and repository mismatches cannot obtain runner admission", async () => {
  for (const installation of [
    { id: 10, app_id: 42, account: { id: 8, type: "User" }, suspended_at: null },
    { id: 10, app_id: 42, account: { id: 7, type: "User" }, suspended_at: "2026-01-01" },
    { id: 10, app_id: 99, account: { id: 7, type: "User" }, suspended_at: null },
  ]) {
    const fetch = vi.fn(async () => Response.json(installation));
    vi.stubGlobal("fetch", fetch);
    await expect(new GitHubAppClient(app).repositoryToken(input)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url.endsWith("/installation")
        ? { id: 10, app_id: 42, account: { id: 7, type: "User" }, suspended_at: null }
        : url.endsWith("/access_tokens")
          ? { token: "secret" }
          : { id: 999, private: true, owner: { id: 7 } },
    ),
  );
  await expect(new GitHubAppClient(app).repositoryToken(input)).rejects.toThrow(
    "verified private personal repository",
  );
});

test("initial repository discovery still issues a token limited to one explicit name", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 10,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ["sandbox"],
        permissions: { administration: "write", metadata: "read" },
      });
      return Response.json({ token: "secret" });
    }
    return Response.json({ id: 123, private: true, owner: { id: 7 } });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await new GitHubAppClient(app).repositoryToken({
    owner: "test-owner",
    repo: "sandbox",
    githubUserId: 7,
  });
  expect(result.repositoryId).toBe(123);
});

test("runner deletion accepts empty responses and preserves HTTP failure status without response secrets", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  const client = new GitHubAppClient(app);
  await expect(
    client.delete("scoped-token", "/repos/test-owner/sandbox/actions/runners/5"),
  ).resolves.toBeUndefined();
  fetch.mockImplementation(async () =>
    Response.json({ message: "private diagnostic" }, { status: 404 }),
  );
  await expect(
    client.delete("scoped-token", "/repos/test-owner/sandbox/actions/runners/5"),
  ).rejects.toMatchObject({ status: 404, message: "GitHub API request failed (404)." });
});

test("job inspection uses read-only Actions permission without runner administration", async () => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/installation"))
      return Response.json({
        id: 10,
        app_id: 42,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [123],
        permissions: { actions: "read", metadata: "read" },
      });
      return Response.json({ token: "read-only-secret" });
    }
    return Response.json({ id: 123, private: true, owner: { id: 7 } });
  });
  expect(
    (await new GitHubAppClient(app).repositoryToken({ ...input, purpose: "jobs" })).repositoryId,
  ).toBe(123);
});
