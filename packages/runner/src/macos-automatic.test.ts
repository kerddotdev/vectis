import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import {
  automaticMacEnrollment,
  automaticMacSetup,
  enrollAutomaticMac,
  macCommandLineTools,
  macSetupPassword,
  MacEnrollmentError,
} from "./macos-automatic.js";
import { bootAutomaticMac } from "./macos-automatic-boot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test.each([
  [false, 26, undefined, false],
  [false, 27, undefined, false],
  [true, 26, undefined, false],
  [true, 27, undefined, true],
  [true, 28, undefined, true],
  [true, 27, true, false],
] as const)(
  "automatic decision: supported=%s guest=%s manual=%s",
  (host, guest, manual, expected) => {
    expect(automaticMacSetup(host, guest, manual)).toBe(expected);
  },
);

function fakeChild() {
  return Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    pid: 2147483647,
    kill: vi.fn(),
  });
}

test("the one-time password travels only over stdin and the private askpass socket", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-auto-test-"));
  const password = macSetupPassword();
  const child = fakeChild();
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
  });
  let askpassPassword = "";
  let helperText = "";
  vi.mocked(spawn).mockImplementationOnce((_executable, _args, options) => {
    const env = options?.env;
    void (async () => {
      helperText = await readFile(String(env?.SSH_ASKPASS), "utf8");
      askpassPassword = await new Promise<string>((resolve) => {
        let output = "";
        const socket = createConnection(String(env?.VECTIS_ASKPASS_SOCKET));
        socket.on("data", (chunk) => {
          output += chunk.toString();
        });
        socket.on("end", () => resolve(output));
      });
      child.emit("close", 0);
    })();
    return child;
  });
  try {
    await writeFile(join(home, "key.pub"), "ssh-ed25519 AAAATEST\n");
    await enrollAutomaticMac(
      {
        host: "192.168.64.20",
        user: "vectis",
        port: 22,
        identityFile: join(home, "key"),
        knownHostsFile: join(home, "known_hosts"),
        hostKeyAlias: "mac",
      },
      password,
      AbortSignal.timeout(5000),
    );
    expect(input).toBe(password + "\n");
    expect(askpassPassword).toBe(password + "\n");
    expect(helperText).not.toContain(password);
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(password);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("NumberOfPasswordPrompts=1");
    expect(args).toContain("PreferredAuthentications=keyboard-interactive,password");
    expect(args?.at(-1)).toContain("sudo -S -p ''");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("owned provisioning boot sends credentials through stdin and cancellation stops only that child", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-auto-boot-"));
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child);
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
  });
  const abort = new AbortController();
  const password = macSetupPassword();
  try {
    const boot = bootAutomaticMac(
      "/synthetic/helper",
      join(home, "bundle"),
      home,
      "attempt",
      2,
      4096,
      password,
      abort.signal,
    );
    child.stdout.write('{"event":"vm.running","macAddress":"02:11:22:33:44:55"}\n');
    expect(await boot.running).toBe("02:11:22:33:44:55");
    expect(JSON.parse(input)).toEqual({ password });
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(password);
    abort.abort();
    expect(child.stdin.writableEnded).toBe(true);
    child.emit("close");
    expect(await boot.stopped).toBe(false);
    expect(await readFile(join(home, "exit-receipt.json"), "utf8")).not.toContain(password);
    boot.stop();
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("enrollment validates sudoers before installing and disables both password methods", () => {
  const script = automaticMacEnrollment("ssh-ed25519 AAAATEST");
  expect(script.indexOf('visudo -cf "$work/sudoers"')).toBeLessThan(script.indexOf("-m 0440"));
  expect(script).toContain("vectis ALL=(ALL) NOPASSWD: ALL");
  expect(script).toContain("PasswordAuthentication no");
  expect(script).toContain("KbdInteractiveAuthentication no");
  expect(script).toContain("/usr/sbin/sshd -t");
  expect(() => automaticMacEnrollment("key\nmalicious command")).toThrow();
  expect(macCommandLineTools).toContain("trap 'sudo -n rm -f");
  expect(macCommandLineTools).toContain("softwareupdate -i");
});

test.each(["Permission denied (password).", "Connection reset by peer"])(
  "enrollment retries account readiness failures: %s",
  async (failure) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-auto-retry-"));
    let attempts = 0;
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      child.exitCode = ++attempts === 1 ? 255 : 0;
      queueMicrotask(() => {
        child.stderr.write(child.exitCode === 255 ? failure : "");
        child.emit("close", child.exitCode);
      });
      return child;
    });
    try {
      await writeFile(join(home, "key.pub"), "ssh-ed25519 AAAATEST\n");
      await enrollAutomaticMac(
        {
          host: "192.168.64.20",
          user: "vectis",
          port: 22,
          identityFile: join(home, "key"),
          knownHostsFile: join(home, "known_hosts"),
          hostKeyAlias: "mac",
        },
        macSetupPassword(),
        AbortSignal.timeout(5000),
      );
      expect(attempts).toBe(2);
      expect(delay).toHaveBeenCalledWith(10000, undefined, { signal: expect.any(AbortSignal) });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["enroll.sudo_check", "enroll.ssh_dir", "enroll.sudoers", "enroll.sshd"])(
  "remote failure is not retried and retains redacted bounded diagnostics at %s",
  async (marker) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-auto-failure-"));
    const password = macSetupPassword();
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = fakeChild();
      child.exitCode = 1;
      queueMicrotask(() => {
        child.stdout.write(marker.slice(0, 8));
        child.stdout.write(marker.slice(8) + "\n");
        child.stdout.write("x".repeat(10000));
        child.stdout.write(password.slice(0, 9));
        child.stdout.write(password.slice(9) + "\n");
        child.stderr.write("Permission denied\nprovisioned user lacks administrator rights\n");
        child.stderr.write(password.slice(0, 20));
        child.stderr.write(password.slice(20) + "\n");
        child.emit("close", 1);
      });
      return child;
    });
    try {
      await writeFile(join(home, "key.pub"), "ssh-ed25519 AAAATEST\n");
      const error: unknown = await enrollAutomaticMac(
        {
          host: "192.168.64.20",
          user: "vectis",
          port: 22,
          identityFile: join(home, "key"),
          knownHostsFile: join(home, "known_hosts"),
          hostKeyAlias: "mac",
        },
        password,
        AbortSignal.timeout(5000),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(MacEnrollmentError);
      if (!(error instanceof MacEnrollmentError)) throw new Error("Expected enrollment failure");
      expect(error.diagnostics).toContain(`step: ${marker}`);
      expect(error.diagnostics).toContain("provisioned user lacks administrator rights");
      expect(error.diagnostics).toContain("[REDACTED]");
      expect(JSON.stringify(error)).not.toContain(password);
      expect(error.diagnostics.length).toBeLessThan(8500);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(delay).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
