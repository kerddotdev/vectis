import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { executeGuest, GuestUnavailableError } from "./guest.js";
import { windowsBootstrapFailure } from "./windows-bootstrap.js";

vi.mock("./guest.js", async (original) => ({
  ...(await original<typeof import("./guest.js")>()),
  executeGuest: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const connection = {
  host: "127.0.0.1",
  port: 2222,
  user: "vectis",
  identityFile: "/isolated/key",
  knownHostsFile: "/isolated/known_hosts",
  hostKeyAlias: "windows-test",
};

test("bootstrap failures retain bounded private details and expose only a known stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-bootstrap-diagnostic-"));
  const diagnostic = {
    stage: "git-verification",
    message: "private error ".repeat(1000),
    line: 99,
  };
  const signal = AbortSignal.timeout(1000);
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify(diagnostic),
    stderr: "",
    truncated: false,
  });
  try {
    const error = await windowsBootstrapFailure(connection, directory, signal);
    expect(error).toMatchObject({ code: "guest_preparation_failed" });
    expect(error.message).toContain("during git-verification");
    expect(error.message).not.toContain("private error");
    const path = join(directory, "bootstrap-diagnostic.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...diagnostic,
      message: diagnostic.message.slice(0, 4096),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(executeGuest).toHaveBeenCalledWith(
      connection,
      expect.stringContaining("diagnostic.json"),
      {
        signal,
        shell: "powershell",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing, malformed or truncated diagnostics preserve the original failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-bootstrap-fallback-"));
  try {
    for (const result of [
      { stdout: "", exitCode: 1, truncated: false },
      { stdout: "not JSON", exitCode: 0, truncated: false },
      {
        stdout: '{"stage":"private-secret","message":"error","line":1}',
        exitCode: 0,
        truncated: false,
      },
      { stdout: '{"stage":"system","message":"error","line":1}', exitCode: 0, truncated: true },
    ]) {
      vi.mocked(executeGuest).mockResolvedValue({ ...result, stderr: "" });
      const error = await windowsBootstrapFailure(connection, directory, AbortSignal.timeout(1000));
      expect(error.message).toBe(
        "Windows bootstrap reported a failure. Inspect private setup diagnostics before resuming.",
      );
    }
    vi.mocked(executeGuest).mockRejectedValue(new GuestUnavailableError("private SSH detail"));
    const error = await windowsBootstrapFailure(connection, directory, AbortSignal.timeout(1000));
    expect(error.code).toBe("guest_preparation_failed");
    expect(error.message).not.toContain("private SSH detail");
    expect(
      await stat(join(directory, "bootstrap-diagnostic.json")).catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
