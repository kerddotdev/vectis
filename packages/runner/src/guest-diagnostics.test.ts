import { afterEach, expect, test, vi } from "vitest";
import { collectRunnerDiagnostics, guestCommandDiagnostics } from "./guest-diagnostics.js";
import { executeGuest, GuestUnavailableError } from "./guest.js";
import { preinstalledRunnerDirectory } from "./runner-release.js";

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

test("guest command tails redact before truncating and retain stderr before stdout within 16 KiB", () => {
  const diagnostics = guestCommandDiagnostics({
    stderr: `discarded-prefix\nAuthorization: Bearer ${"a".repeat(12000)}\n${"é".repeat(5000)}\npermission denied token=ghp_DiagnosticCanary123456789`,
    stdout: `discarded-prefix\n${"漢".repeat(5000)}\nvectis-provision: download`,
  });
  expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThan(16384);
  const [stderr, stdout] = diagnostics.split("\n== stdout\n");
  expect(Buffer.byteLength(stderr ?? "", "utf8")).toBeLessThanOrEqual(4106);
  expect(Buffer.byteLength(stdout ?? "", "utf8")).toBeLessThanOrEqual(4096);
  expect(diagnostics).not.toContain("discarded-prefix");
  expect(diagnostics).not.toContain("a".repeat(100));
  expect(diagnostics).not.toContain("DiagnosticCanary");
  expect(diagnostics).not.toContain("\uFFFD");
  expect(diagnostics).toContain("permission denied token=[redacted]");
  expect(diagnostics).toContain("vectis-provision: download");
  expect(diagnostics.indexOf("== stderr")).toBeLessThan(diagnostics.indexOf("== stdout"));
});

test("guest command diagnostics remove complete private keys and preserve short errors", () => {
  expect(
    guestCommandDiagnostics({
      stderr: "sudo: a password is required",
      stdout: `-----BEGIN OPENSSH PRIVATE KEY-----\n${"s".repeat(6000)}\n-----END OPENSSH PRIVATE KEY-----\nvectis-provision: directory`,
    }),
  ).toBe(
    "== stderr\nsudo: a password is required\n== stdout\n[redacted]\nvectis-provision: directory",
  );
});
test.each(["linux", "macos", "windows"] as const)(
  "%s diagnostics read logs from the runner's baked installation",
  async (os) => {
    vi.mocked(executeGuest).mockResolvedValue({
      exitCode: 0,
      stdout: "runner diagnostic",
      stderr: "",
      truncated: false,
    });
    expect(
      await collectRunnerDiagnostics({
        connection,
        os,
        listener: "",
        secrets: [],
        preinstalled: true,
      }),
    ).toContain("runner diagnostic");
    expect(executeGuest).toHaveBeenCalledWith(
      connection,
      expect.stringContaining(preinstalledRunnerDirectory(os)),
      expect.objectContaining({ shell: os === "windows" ? "powershell" : "bash" }),
    );
  },
);

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

test("credentials are removed from listener and guest output before diagnostic tails are cut", async () => {
  const canary = "ghu_GuestDiagnosticCanary123456789";
  const known = "KnownJitConfigCanary123456789";
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 23,
    stdout: `Authorization: Bearer ${"a".repeat(15000)}\n${canary} host runner.local`,
    stderr: `config ${known} exit 23`,
    truncated: false,
  });
  const text = await collectRunnerDiagnostics({
    connection,
    os: "windows",
    listener: `--jitconfig ${"b".repeat(4000)}\n${canary}`,
    secrets: [known],
  });
  expect(text).not.toContain(canary);
  expect(text).not.toContain(known);
  expect(text).not.toContain("a".repeat(100));
  expect(text).not.toContain("b".repeat(100));
  expect(text).toContain("host runner.local");
  expect(text).toContain("exit 23");
});
