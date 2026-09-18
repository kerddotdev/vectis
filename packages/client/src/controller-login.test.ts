import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  beginControllerLogin,
  finishControllerLogin,
  logoutController,
} from "./controller-login.js";
import { controllerClient } from "./controller.js";

const deployment = "https://isolated-test.convex.cloud";
function credentials() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (account: string) => entries.get(account) ?? null,
    set: async (account: string, value: string) => {
      entries.set(account, value);
    },
    remove: async (account: string) => {
      entries.delete(account);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

test("login resumes without a running service and persists secrets only in the credential store", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-controller-"));
  const secrets = credentials();
  try {
    const first = await beginControllerLogin(home, deployment, "Test CLI", secrets);
    expect(await beginControllerLogin(home, deployment, "Test CLI", secrets)).toEqual(first);
    const stored = [...secrets.entries.values()][0];
    if (!stored) throw new Error("Expected a test credential");
    const values = Schema.decodeUnknownSync(
      Schema.Struct({ request: Schema.String, credential: Schema.String }),
    )(JSON.parse(stored));
    const metadata = await readFile(join(home, "controller-pending.json"), "utf8");
    for (const value of [values.request, values.credential]) {
      expect(metadata).not.toContain(value);
      expect(first.url).not.toContain(value);
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ state: "pending" }))
      .mockResolvedValueOnce(
        Response.json({ controllerId: "controller1", expiresAt: Date.now() + 600000 }),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetcher);
    expect(await finishControllerLogin(home, secrets)).toEqual({ state: "pending" });
    expect(await finishControllerLogin(home, secrets)).toEqual({
      state: "linked",
      controllerId: "controller1",
    });
    const connection = await readFile(join(home, "controller.json"), "utf8");
    expect(connection).not.toContain(values.credential);
    expect((await stat(join(home, "controller.json"))).mode & 0o777).toBe(0o600);
    expect(secrets.entries.size).toBe(1);
    await expect(readFile(join(home, "controller-pending.json"))).rejects.toThrow();
    fetcher.mockResolvedValueOnce(Response.json({ revoked: true }));
    expect(await logoutController(home, secrets)).toEqual({ state: "signed_out" });
    expect(secrets.entries.size).toBe(0);
    await expect(controllerClient(home, secrets)).rejects.toMatchObject({ code: "login_required" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed logout keeps credentials for retry while an already revoked connection can be removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-controller-"));
  const secrets = credentials();
  try {
    await beginControllerLogin(home, deployment, "Test CLI", secrets);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ controllerId: "controller1", expiresAt: Date.now() + 600000 }),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetcher);
    await finishControllerLogin(home, secrets);
    fetcher.mockResolvedValueOnce(Response.json({ code: "cloud_unavailable" }, { status: 503 }));
    await expect(logoutController(home, secrets)).rejects.toMatchObject({
      code: "cloud_unavailable",
    });
    expect(secrets.entries.size).toBe(1);
    await expect(controllerClient(home, secrets)).resolves.toBeDefined();
    fetcher.mockResolvedValueOnce(
      Response.json({ code: "controller_unauthorized" }, { status: 401 }),
    );
    await expect(logoutController(home, secrets)).resolves.toEqual({ state: "signed_out" });
    expect(secrets.entries.size).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
