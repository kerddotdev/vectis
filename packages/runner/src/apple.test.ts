import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { requestAppleVmShutdown, waitForAppleVm } from "./apple.js";

test.each(["accepted", "unavailable", "old-helper", "invalid", "oversized", "error"])(
  "Apple shutdown request handles %s and releases listeners",
  async (mode) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const readline = require('node:readline');
console.log(JSON.stringify({event:'vm.running'}));
readline.createInterface({input:process.stdin}).on('line', line => {
  if (line !== 'shutdown') process.exit(97);
  const mode = '${mode}';
  if (mode === 'old-helper') return;
  if (mode === 'invalid') return console.log('invalid');
  if (mode === 'oversized') return console.log('x'.repeat(65537));
  console.log(JSON.stringify({event: mode === 'accepted' ? 'vm.shutdown_requested' : mode === 'error' ? 'vm.error' : 'vm.shutdown_unavailable'}));
});`,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const closed = once(child, "close");
    try {
      await waitForAppleVm(child);
      const errorListeners = child.listenerCount("error");
      const dataListeners = child.stdout.listenerCount("data");
      await expect(requestAppleVmShutdown(child, mode === "old-helper" ? 20 : 1000)).resolves.toBe(
        mode === "accepted",
      );
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.stdout.listenerCount("data")).toBe(dataListeners);
      expect(child.stdin.listenerCount("error")).toBe(0);
      expect(child.listenerCount("error")).toBe(errorListeners);
    } finally {
      child.stdin.end();
      await closed;
    }
  },
);

test("requires an explicit VM running event rather than process creation", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write(JSON.stringify({event:"vm.running"})+"\\n")'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(child, "exit");
  await expect(waitForAppleVm(child)).resolves.toEqual({});
  await exited;
});

test("rejects a helper that exits before readiness", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await expect(waitForAppleVm(child)).rejects.toMatchObject({ code: "vm_start_failed" });
});

test("rejects malformed helper output", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("invalid\\n")'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = once(child, "exit");
  await expect(waitForAppleVm(child)).rejects.toMatchObject({ code: "vm_start_failed" });
  await exited;
});

test("retains the owned VM network identity for guest discovery", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stdout.write(JSON.stringify({event:"vm.running", macAddress:"02:00:00:00:00:01"})+"\\n")',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(child, "exit");
  await expect(waitForAppleVm(child)).resolves.toEqual({ macAddress: "02:00:00:00:00:01" });
  await exited;
});

test.each([
  ["rosetta_not_installed", "softwareupdate --install-rosetta"],
  ["rosetta_unsupported", "configure x64 off"],
])("maps helper %s to an actionable coded error", async (code, nextStep) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify({event:"vm.error",code:${JSON.stringify(code)}})+"\\n")`,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const exited = once(child, "exit");
  await expect(waitForAppleVm(child)).rejects.toMatchObject({
    code,
    nextStep: expect.stringContaining(nextStep),
  });
  await exited;
});

test("unrecognized helper error codes cannot become service error codes", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write('{"event":"vm.error","code":"arbitrary"}\\n')`],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const exited = once(child, "exit");
  await expect(waitForAppleVm(child)).rejects.toMatchObject({ code: "vm_start_failed" });
  await exited;
});
