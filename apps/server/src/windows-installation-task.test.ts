import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.js";
import { Service } from "./service.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { recoverWindowsInstallations } from "./windows-installation-task.js";

function record(directory: string) {
  return {
    id: "setup",
    attemptId: "attempt",
    directory,
    phase: "booting",
    configuration: {
      id: "windows",
      name: "Windows",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: directory,
      storagePath: directory,
      isoPath: join(directory, "windows.iso"),
      driversPath: join(directory, "drivers.iso"),
      firmwarePath: join(directory, "code.fd"),
      firmwareVarsPath: join(directory, "vars.fd"),
      imageName: "Windows 11 Pro",
      acceptLicense: true,
    },
  };
}

test("Windows recovery requires its exact attempt receipt and a stopped supervisor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-windows-recovery-"));
  const store = new Store(":memory:");
  try {
    store.put("windowsInstallation", "setup", record(directory));
    for (const receipt of [
      { instanceId: "other", pid: 2147483647 },
      { instanceId: "attempt", pid: process.pid },
    ]) {
      await writeFile(join(directory, "exit-receipt.json"), JSON.stringify(receipt));
      await recoverWindowsInstallations(store);
      expect(store.snapshot().preparationBusy).toBe(true);
    }
    await writeFile(
      join(directory, "exit-receipt.json"),
      JSON.stringify({ instanceId: "attempt", pid: 2147483647 }),
    );
    await recoverWindowsInstallations(store);
    expect(store.snapshot().preparationBusy).toBe(false);
    expect(store.get("windowsInstallation", "setup")).toMatchObject({ phase: "interrupted" });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfirmed Windows setup blocks other VM admission and both Apple installers", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/isolated-vectis-test" }));
  const setup = record("/isolated-vectis-test");
  store.put("windowsInstallation", "setup", setup);
  try {
    const vm = service.submit("vm", { type: "environment.start", id: "linux" });
    const linux = service.submit("linux", {
      type: "environment.prepare-linux",
      ...setup.configuration,
      id: "linux",
    });
    const mac = service.submit("mac", {
      type: "environment.install-macos",
      ...setup.configuration,
      id: "mac",
      restorePath: "/isolated-vectis-test/restore.ipsw",
    });
    await service.drain();
    expect(store.get("operation", vm.id)).toMatchObject({ result: { code: "preparation_active" } });
    for (const operation of [linux, mac])
      expect(store.get("operation", operation.id)).toMatchObject({
        result: { code: "reconciliation_required" },
      });
    expect(store.snapshot().instances).toHaveLength(0);
    expect(store.list("preparation")).toHaveLength(0);
    expect(store.list("macInstallation")).toHaveLength(0);
  } finally {
    await service.close();
    store.close();
  }
});
