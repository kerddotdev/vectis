import { afterEach, expect, test, vi } from "vitest";
import { collectRunnerDiagnostics } from "./guest-diagnostics.js";
import { executeGuest, GuestUnavailableError } from "./guest.js";

vi.mock("./guest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./guest.js")>()),
  executeGuest: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const connection = {
  host: "127.0.0.1",
  port: 2222,
  user: "vectis",
  identityFile: "/test/key",
  knownHostsFile: "/test/hosts",
  hostKeyAlias: "test",
};

test("diagnostics are scrubbed of secrets and bounded", async () => {
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 0,
    stdout: `== uptime\nup\n${"x".repeat(50000)}`,
    stderr: "",
    truncated: true,
  });
  const text = await collectRunnerDiagnostics({
    connection,
    os: "linux",
    listener: "config c2VjcmV0 failed",
    secrets: ["c2VjcmV0"],
  });
  expect(text).not.toContain("c2VjcmV0");
  expect(text).toContain("config [redacted] failed");
  expect(text.length).toBeLessThanOrEqual(16384);
});

test("an unreachable guest is reported with the connection error instead of failing", async () => {
  vi.mocked(executeGuest).mockRejectedValue(
    new GuestUnavailableError("exit 255: No route to host"),
  );
  const text = await collectRunnerDiagnostics({
    connection,
    os: "macos",
    listener: "",
    secrets: [],
  });
  expect(text).toContain("unreachable: exit 255: No route to host");
  expect(text).toContain("guest is forwarded through a loopback port");
});
