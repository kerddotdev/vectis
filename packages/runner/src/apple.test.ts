import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { waitForAppleVm } from "./apple.js";

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
