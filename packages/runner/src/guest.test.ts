import { expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { guestCommandDiagnostics } from "./guest-diagnostics.js";
import { guestArguments, executeGuest } from "./guest.js";

const connection = {
  host: "192.168.64.2",
  port: 22,
  user: "runner",
  identityFile: "/isolated/guest-key",
  knownHostsFile: "/isolated/known-hosts",
  hostKeyAlias: "vectis-test-image",
};
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  ...processMock,
}));

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  processMock.spawn.mockReturnValue(process);
  return process;
}

test("rejects SSH option injection and requires pinned guest host keys", () => {
  for (const host of ["-oProxyCommand=command", "user@host", "127.0.0.1;command"])
    expect(() => guestArguments({ ...connection, host })).toThrow("invalid");
  expect(() => guestArguments({ ...connection, port: 65536 })).toThrow("invalid");
  const args = guestArguments(connection);
  expect(args).toEqual(
    expect.arrayContaining([
      "StrictHostKeyChecking=yes",
      "IdentityAgent=none",
      "ForwardAgent=no",
      "BatchMode=yes",
      "ClearAllForwardings=yes",
      "HostKeyAlias=vectis-test-image",
      "/dev/null",
    ]),
  );
});

test.each(["bash", "powershell", "cmd"] as const)(
  "%s sends scripts through stdin and bounds retained guest output",
  async (shell) => {
    const process = child();
    const script = "printf '%s' '$(host-command)'";
    const result = executeGuest(connection, script, { signal: AbortSignal.timeout(5000), shell });
    expect(processMock.spawn).toHaveBeenCalledWith(
      "/usr/bin/ssh",
      expect.not.arrayContaining([script]),
      expect.anything(),
    );
    expect(process.stdin.read().toString()).toBe(script + "\n");
    process.stdout.write("a".repeat(50000));
    process.stdout.write("guest-end");
    process.exitCode = 7;
    process.emit("close");
    await expect(result).resolves.toMatchObject({ exitCode: 7, truncated: true });
    expect((await result).stdout).toHaveLength(32768);
    expect((await result).stdout.endsWith("guest-end")).toBe(true);
  },
);

test("registry commands use cmd directly without a PowerShell script block", async () => {
  const process = child();
  const script = 'reg.exe add "HKLM\\SOFTWARE\\Policies\\Example" /v Test /t REG_DWORD /d 1 /f';
  const result = executeGuest(connection, script, {
    signal: AbortSignal.timeout(5000),
    shell: "cmd",
  });
  expect(processMock.spawn.mock.lastCall?.[1].at(-1)).toBe("cmd.exe /d /q");
  expect(process.stdin.read().toString()).toBe(script + "\n");
  process.exitCode = 0;
  process.emit("close");
  expect((await result).exitCode).toBe(0);
});

const nativeProcess =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const hasPowerShell =
  nativeProcess.spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

test.skipIf(!hasPowerShell).each([
  {
    name: "runtime error",
    script: "throw 'Synthetic guest failure'",
    cause: "Synthetic guest failure",
  },
  { name: "parser error", script: "if (", cause: "Missing condition" },
  { name: "bounded record", script: "throw ('x' * 20000)", cause: "xxxx" },
])("PowerShell wrapper preserves the $name on stderr", async ({ script, cause }) => {
  processMock.spawn.mockImplementationOnce((_executable, args: string[]) => {
    const command = args.at(-1) ?? "";
    const prefix = 'powershell.exe -NoLogo -NonInteractive -NoProfile -Command "';
    expect(command.startsWith(prefix)).toBe(true);
    return nativeProcess.spawn(
      "pwsh",
      ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", command.slice(prefix.length, -1)],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...globalThis.process.env, NO_COLOR: "1" },
      },
    );
  });
  const result = await executeGuest(connection, script, {
    signal: AbortSignal.timeout(10000),
    shell: "powershell",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(cause);
  expect(result.stderr.length).toBeLessThanOrEqual(16385);
  expect(guestCommandDiagnostics(result)).toContain(cause);
  expect(result.stderr).not.toContain("Guest script failed.");
});

test("cancellation stops only the owned SSH process and does not report completion", async () => {
  const process = child();
  const controller = new AbortController();
  const result = executeGuest(connection, "sleep 600", { signal: controller.signal });
  const rejection = expect(result).rejects.toMatchObject({ code: "guest_cancelled" });
  controller.abort();
  expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  process.signalCode = "SIGTERM";
  process.emit("close");
  await rejection;
});
