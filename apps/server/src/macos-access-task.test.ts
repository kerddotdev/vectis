import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { Store } from "./store.js";
import { completedMacEnvironment, verifyMacSetupOutput } from "./macos-access-task.js";

test("macOS readiness rejects encrypted guests, wrong versions, architecture and clock drift", () => {
  const now = Math.floor(Date.now() / 1000);
  expect(() => verifyMacSetupOutput(`arm64 ${now}\nFileVault is Off.\n26.6.2\n`)).not.toThrow();
  expect(() => verifyMacSetupOutput(`arm64 ${now}\nFileVault is On.\n26.6.2\n`)).toThrow(
    "Guest FileVault",
  );
  expect(() => verifyMacSetupOutput(`arm64 ${now}\nFileVault is Off.\n27.0\n`)).toThrow("macOS 26");
  expect(() => verifyMacSetupOutput(`x86_64 ${now}\nFileVault is Off.\n26.6.2\n`)).toThrow("ARM64");
  expect(() => verifyMacSetupOutput("arm64 1\nFileVault is Off.\n26.6.2\n")).toThrow("clock");
});

test("finishing macOS setup requires verified access from the same stopped session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-macos-finish-"));
  const store = new Store(":memory:");
  const record = {
    id: "setup",
    attemptId: "console-session",
    directory,
    bundle: join(directory, "base.bundle"),
    phase: "setup_required",
    configuration: {
      id: "mac",
      name: "Mac",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: directory,
      storagePath: directory,
    },
  };
  try {
    store.put("macInstallation", "setup", record);
    await expect(completedMacEnvironment(store, "setup")).rejects.toMatchObject({
      code: "guest_setup_incomplete",
    });
    store.put("macInstallation", "setup", { ...record, sshVerifiedAttempt: "previous-console" });
    await writeFile(
      join(directory, "exit-receipt.json"),
      JSON.stringify({ instanceId: "console-session", pid: 2147483647 }),
    );
    await expect(completedMacEnvironment(store, "setup")).rejects.toMatchObject({
      code: "guest_setup_incomplete",
    });
    store.put("macInstallation", "setup", { ...record, sshVerifiedAttempt: "console-session" });
    expect(await completedMacEnvironment(store, "setup")).toMatchObject({
      id: "mac",
      sshUser: "vectis",
      sshKeyPath: join(directory, "guest-key"),
      state: "ready",
    });
    expect(store.snapshot().environments).toHaveLength(0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
