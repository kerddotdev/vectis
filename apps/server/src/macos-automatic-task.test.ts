import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import * as installation from "../../../packages/runner/src/macos-installation.js";
import * as processes from "../../../packages/runner/src/process.js";
import * as automatic from "./macos-automatic-task.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

test.each([false, true])(
  "restored bundle survives automatic failure or manual opt-out: %s",
  async (manual) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-auto-service-"));
    const store = new Store(":memory:");
    const service = new Service(store, new VmRuntime({ home, appleHelper: "/synthetic/helper" }));
    const bundle = join(home, "base.bundle");
    const validate = vi.spyOn(installation, "validateMacInstallation").mockResolvedValue();
    const install = vi
      .spyOn(installation, "installMacGuest")
      .mockResolvedValue({ bundle, build: "26B123" });
    const capability = vi.spyOn(processes, "runProcess").mockResolvedValue("true\n");
    const setup = vi
      .spyOn(automatic, "automateMacSetup")
      .mockImplementation(async (state, _runtime, operation) => {
        state.update(operation, {
          result: { setupId: operation.id, step: "macos.installing_clt" },
        });
        throw new Error("synthetic credential must not be persisted");
      });
    try {
      await mkdir(bundle);
      await writeFile(join(bundle, "installation.json"), JSON.stringify({ majorVersion: 27 }));
      const operation = service.submit("install", {
        type: "environment.install-macos",
        id: "mac",
        name: "Mac",
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
        imageDirectory: home,
        storagePath: home,
        ...(manual ? { manualSetup: true as const } : {}),
      });
      await service.drain();
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
          "action_required",
        ),
      );
      const result = store.snapshot().operations.find((item) => item.id === operation.id);
      expect(result).toMatchObject({
        status: "action_required",
        result: {
          setupId: operation.id,
          bundle,
          phase: "setup_required",
          setupMode: manual ? "manual" : "automatic",
        },
      });
      if (manual) expect(setup).not.toHaveBeenCalled();
      else expect(result?.result).toMatchObject({ failedStep: "macos.installing_clt" });
      expect(store.get("macInstallation", operation.id)).toMatchObject({
        phase: "setup_required",
        bundle,
      });
      expect(store.snapshot().environments).toHaveLength(0);
      expect(JSON.stringify(store.snapshot())).not.toContain("synthetic credential");
    } finally {
      await service.close();
      store.close();
      validate.mockRestore();
      install.mockRestore();
      capability.mockRestore();
      setup.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["success", "tools_failure", "enrollment_failure"])(
  "automatic pipeline registers only after toolchain, verification and clean shutdown: %s",
  async (outcome) => {
    const toolsAvailable = outcome !== "tools_failure";
    const succeeds = outcome === "success";
    const bootModule = await import("../../../packages/runner/src/macos-automatic-boot.js");
    const automaticModule = await import("../../../packages/runner/src/macos-automatic.js");
    const accessModule = await import("../../../packages/runner/src/macos-access.js");
    const addressModule = await import("../../../packages/runner/src/guest-address.js");
    const guestModule = await import("../../../packages/runner/src/guest.js");
    const home = await mkdtemp(join(tmpdir(), "vectis-auto-pipeline-"));
    const store = new Store(":memory:");
    const runtime = new VmRuntime({ home, appleHelper: "/synthetic/helper" });
    const runtimeValidation = vi.spyOn(runtime, "validate").mockResolvedValue();
    const service = new Service(store, runtime);
    const bundle = join(home, "base.bundle");
    const mocks = [
      vi.spyOn(installation, "validateMacInstallation").mockResolvedValue(),
      vi
        .spyOn(installation, "installMacGuest")
        .mockImplementation(async (_input, _helper, directory) => {
          await mkdir(directory);
          return { bundle, build: "26B123" };
        }),
      vi.spyOn(processes, "runProcess").mockResolvedValue("true\n"),
      vi.spyOn(addressModule, "waitForGuestAddress").mockResolvedValue("192.168.64.20"),
      vi.spyOn(automaticModule, "waitForMacSsh").mockResolvedValue(),
      vi.spyOn(automaticModule, "enrollAutomaticMac").mockImplementation(async () => {
        if (outcome === "enrollment_failure")
          throw new automaticModule.MacEnrollmentError(
            "step: enroll.sudo_check\nprovisioned user lacks administrator rights",
          );
      }),
      vi.spyOn(accessModule, "prepareMacAccess").mockImplementation(async (directory) => ({
        path: join(directory, "connect.command"),
        connection: {
          host: "192.168.64.20",
          port: 22,
          user: "vectis",
          identityFile: join(directory, "guest-key"),
          knownHostsFile: join(directory, "known_hosts"),
          hostKeyAlias: "mac",
        },
      })),
    ];
    let finish: (clean: boolean) => void = () => {};
    let directory = "";
    let attemptId = "";
    const stopped = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const boot = vi
      .spyOn(bootModule, "bootAutomaticMac")
      .mockImplementation((_helper, _bundle, ownedDirectory, id) => {
        directory = ownedDirectory;
        attemptId = id;
        return {
          running: Promise.resolve("02:11:22:33:44:55"),
          stopped,
          stop: () => finish(false),
        };
      });
    const guest = vi
      .spyOn(guestModule, "executeGuest")
      .mockImplementation(async (_connection, script) => {
        if (script === automaticModule.macCommandLineTools && !toolsAvailable)
          return { exitCode: 1, stdout: "", stderr: "catalog unavailable", truncated: false };
        if (script.includes("shutdown -h now")) {
          expect(store.snapshot().environments).toHaveLength(0);
          await writeFile(
            join(directory, "exit-receipt.json"),
            JSON.stringify({ instanceId: attemptId, pid: 2147483647 }),
          );
          finish(true);
        }
        return {
          exitCode: 0,
          stdout: `arm64 ${Math.floor(Date.now() / 1000)}\nFileVault is Off.\n27.2\n/Library/Developer/CommandLineTools|git version 2.50|clang|swift`,
          stderr: "",
          truncated: false,
        };
      });
    try {
      await mkdir(bundle);
      await writeFile(join(bundle, "installation.json"), JSON.stringify({ majorVersion: 27 }));
      const operation = service.submit("automatic", {
        type: "environment.install-macos",
        id: "mac",
        name: "Mac",
        imageDirectory: home,
        storagePath: home,
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
      });
      await service.drain();
      await vi.waitFor(() =>
        expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
          succeeds ? "succeeded" : "action_required",
        ),
      );
      expect(store.snapshot().environments).toHaveLength(succeeds ? 1 : 0);
      expect(store.get("macInstallation", operation.id)).toMatchObject({
        phase: succeeds ? "registered" : "setup_required",
        bundle,
      });
      expect(runtimeValidation).toHaveBeenCalledTimes(succeeds ? 1 : 0);
      if (outcome === "enrollment_failure") {
        expect(store.operation(operation.id)?.result).toMatchObject({
          failedStep: "macos.enrolling",
          code: "macos_automatic_setup_incomplete",
          diagnostics: "step: enroll.sudo_check\nprovisioned user lacks administrator rights",
        });
        expect(guest).not.toHaveBeenCalled();
      }
      const password = boot.mock.calls[0]?.[7];
      expect(password).toBeTruthy();
      expect(JSON.stringify(store.snapshot())).not.toContain(password);
    } finally {
      finish(false);
      await service.close();
      store.close();
      for (const mock of mocks) mock.mockRestore();
      boot.mockRestore();
      guest.mockRestore();
      runtimeValidation.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  },
);
