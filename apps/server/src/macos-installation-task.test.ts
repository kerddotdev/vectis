import { Service } from "./service.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as macInstallation from "../../../packages/runner/src/macos-installation.js";
import * as process from "../../../packages/runner/src/process.js";
import { Store } from "./store.js";
import {
  hasUnconfirmedMacInstallation,
  recoverMacInstallations,
} from "./macos-installation-task.js";

test("automatic setup timeout preserves the bundle and requires attention", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mac-setup-timeout-"));
  const bundle = join(home, "base.bundle");
  const store = new Store(":memory:");
  const runtime = new VmRuntime({ home, appleHelper: join(home, "synthetic-helper") });
  const service = new Service(store, runtime);
  const validate = vi.spyOn(macInstallation, "validateMacInstallation").mockResolvedValue();
  const install = vi.spyOn(macInstallation, "installMacGuest").mockResolvedValue({
    bundle,
    build: "26B123",
  });
  const runProcess = vi
    .spyOn(process, "runProcess")
    .mockImplementation(async (_path, _args, signal) => {
      signal?.throwIfAborted();
      return "true\n";
    });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let timeoutCalls = 0;
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    timeoutCalls++;
    return timeoutCalls === 2 ? AbortSignal.abort() : timeout(milliseconds);
  });
  try {
    await mkdir(bundle);
    await writeFile(join(bundle, "installation.json"), JSON.stringify({ majorVersion: 27 }));
    const operation = service.submit("setup-timeout", {
      type: "environment.install-macos",
      id: "mac",
      name: "Mac",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: home,
      storagePath: home,
    });
    await service.drain();
    expect(store.operation(operation.id)).toMatchObject({
      status: "action_required",
      message: "Automatic macOS setup timed out at macos.provisioning. The bundle is preserved.",
      result: {
        bundle,
        phase: "setup_required",
        setupMode: "automatic",
        failedStep: "macos.provisioning",
      },
    });
    expect(store.get("macInstallation", operation.id)).toMatchObject({
      phase: "setup_required",
      bundle,
    });
    expect(store.snapshot().environments).toHaveLength(0);
  } finally {
    await service.close();
    store.close();
    validate.mockRestore();
    install.mockRestore();
    runProcess.mockRestore();
    timeoutSpy.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});

test("recovery preserves a completed restore instead of installing it twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-mac-recovery-"));
  const store = new Store(":memory:");
  try {
    const bundle = join(directory, "base.bundle");
    await mkdir(bundle);
    for (const name of [
      "disk.img",
      "hardware-model.bin",
      "machine-identifier.bin",
      "auxiliary-storage.bin",
    ])
      await writeFile(join(bundle, name), "test");
    await writeFile(
      join(bundle, "installation.json"),
      JSON.stringify({ build: "test-build", state: "action_required" }),
    );
    store.put("macInstallation", "setup", {
      id: "setup",
      attemptId: "attempt",
      directory,
      phase: "installing",
      configuration: {
        id: "mac",
        name: "Mac",
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
        imageDirectory: directory,
        storagePath: directory,
        restorePath: join(directory, "restore.ipsw"),
      },
    });
    await recoverMacInstallations(store);
    expect(hasUnconfirmedMacInstallation(store)).toBe(true);
    await writeFile(
      join(directory, "exit-receipt.json"),
      JSON.stringify({ instanceId: "wrong", pid: 2147483647 }),
    );
    await recoverMacInstallations(store);
    expect(hasUnconfirmedMacInstallation(store)).toBe(true);
    await writeFile(
      join(directory, "exit-receipt.json"),
      JSON.stringify({ instanceId: "attempt", pid: 2147483647 }),
    );
    await recoverMacInstallations(store);
    expect(store.get("macInstallation", "setup")).toMatchObject({
      phase: "setup_required",
      bundle,
      build: "test-build",
    });
    expect(hasUnconfirmedMacInstallation(store)).toBe(false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed macOS setup is not restored again by a resume command", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/isolated-unused-home" }));
  store.put("macInstallation", "setup", {
    id: "setup",
    attemptId: "attempt",
    directory: "/isolated",
    phase: "setup_required",
    bundle: "/isolated/base.bundle",
    build: "test-build",
    configuration: {
      id: "mac",
      name: "Mac",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: "/isolated",
      storagePath: "/isolated",
      restorePath: "/isolated/absent.ipsw",
    },
  });
  try {
    const op = service.submit("resume", { type: "environment.resume-macos", id: "setup" });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === op.id)).toMatchObject({
      status: "action_required",
      result: { phase: "setup_required", bundle: "/isolated/base.bundle" },
    });
    expect(store.snapshot().environments).toHaveLength(0);
  } finally {
    await service.close();
    store.close();
  }
});

test.each(["installing", "setup_running"])(
  "an unconfirmed macOS %s prevents Linux preparation and VM admission",
  async (phase) => {
    const store = new Store(":memory:");
    const service = new Service(store, new VmRuntime({ home: "/isolated-unused-home" }));
    const configuration = {
      id: "mac",
      name: "Mac",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: "/isolated",
      storagePath: "/isolated",
      restorePath: "/isolated/absent.ipsw",
    };
    store.put("macInstallation", "setup", {
      id: "setup",
      attemptId: "attempt",
      directory: "/isolated",
      phase,
      configuration,
    });
    try {
      const prepare = service.submit("prepare", {
        type: "environment.prepare-linux",
        ...configuration,
        id: "linux",
      });
      const start = service.submit("start", { type: "environment.start", id: "linux" });
      await service.drain();
      expect(store.snapshot().operations.find((item) => item.id === prepare.id)).toMatchObject({
        status: "action_required",
        result: { code: "reconciliation_required" },
      });
      expect(store.snapshot().operations.find((item) => item.id === start.id)).toMatchObject({
        status: "failed",
        result: { code: "preparation_active" },
      });
      expect(store.list("preparation")).toHaveLength(0);
      expect(store.snapshot().instances).toHaveLength(0);
    } finally {
      await service.close();
      store.close();
    }
  },
);

test("a service restart preserves a macOS download source without requiring a VM exit receipt", async () => {
  const store = new Store(":memory:");
  const { operation } = store.accept("download", "download", "environment.install-macos");
  store.update(operation, {
    status: "running",
    result: { setupId: "setup", phase: "downloading" },
  });
  const source = {
    directory: "/isolated/restore",
    owner: "setup",
    artifact: { url: "https://images.test/restore.ipsw", sha256: "a".repeat(64), bytes: 123 },
  };
  store.put("macInstallation", "setup", {
    id: "setup",
    attemptId: operation.id,
    directory: "/isolated/attempt",
    phase: "downloading",
    restoreDownload: source,
    configuration: {
      id: "mac",
      name: "Mac",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: "/isolated",
      storagePath: "/isolated",
    },
  });
  try {
    expect(store.snapshot().preparationBusy).toBe(true);
    store.recover();
    await recoverMacInstallations(store);
    expect(store.get("macInstallation", "setup")).toMatchObject({
      phase: "interrupted",
      restoreDownload: source,
    });
    expect(hasUnconfirmedMacInstallation(store)).toBe(false);
    expect(store.snapshot().preparationBusy).toBe(false);
    expect(store.snapshot().operations[0]).toMatchObject({
      status: "action_required",
      result: { phase: "interrupted", setupId: "setup", restoreDirectory: source.directory },
    });
  } finally {
    store.close();
  }
});

test("resuming a persisted macOS 26 download keeps its original artifact after the default pin changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mac-resume-"));
  const store = new Store(":memory:");
  const service = new Service(
    store,
    new VmRuntime({ home, appleHelper: join(home, "synthetic-helper") }),
  );
  const source = {
    directory: join(home, "restore"),
    owner: "setup",
    artifact: {
      url: "https://updates.cdn-apple.com/2026SummerFCS/fullrestores/140-75212/A2A24B94-1FC1-45A3-93F7-C51B02AF1F4D/UniversalMac_26.6.2_25G83_Restore.ipsw",
      sha256: "885503b7f4b06609e9a512f2befd40f59730640a3f1233e3892d60affdd51c95",
      bytes: 19772231540,
    },
  };
  const validate = vi.spyOn(macInstallation, "validateMacInstallation").mockResolvedValue();
  const install = vi.spyOn(macInstallation, "installMacGuest").mockResolvedValue({
    bundle: join(home, "base.bundle"),
    build: "25G83",
  });
  try {
    store.put("macInstallation", "setup", {
      id: "setup",
      attemptId: "old-attempt",
      directory: join(home, "old-attempt"),
      phase: "downloading",
      restoreDownload: source,
      configuration: {
        id: "mac",
        name: "Mac",
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
        imageDirectory: home,
        storagePath: home,
      },
    });
    const operation = service.submit("resume-old-download", {
      type: "environment.resume-macos",
      id: "setup",
    });
    await service.drain();
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mac" }),
      join(home, "synthetic-helper"),
      source,
    );
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mac" }),
      join(home, "synthetic-helper"),
      expect.any(String),
      operation.id,
      expect.any(AbortSignal),
      source,
      expect.any(Function),
    );
    expect(store.get("macInstallation", "setup")).toMatchObject({
      phase: "setup_required",
      build: "25G83",
      restoreDownload: source,
    });
  } finally {
    await service.close();
    validate.mockRestore();
    install.mockRestore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
