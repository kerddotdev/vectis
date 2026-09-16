import { expect, test } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";

test.each(["preparation", "macInstallation", "windowsInstallation"])(
  "a stopped %s keeps its environment identifier reserved",
  async (kind) => {
    const store = new Store(":memory:");
    const service = new Service(store, new VmRuntime({ home: "/isolated-vectis-test" }));
    const setup = {
      id: "setup",
      attemptId: "attempt",
      directory: "/isolated-vectis-test",
      configuration: {
        id: "reserved",
        name: "Reserved",
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
        imageDirectory: "/isolated-vectis-test",
        storagePath: "/isolated-vectis-test",
        restorePath: "/isolated-vectis-test/restore.ipsw",
        isoPath: "/isolated-vectis-test/windows.iso",
        driversPath: "/isolated-vectis-test/drivers.iso",
        firmwarePath: "/isolated-vectis-test/code.fd",
        firmwareVarsPath: "/isolated-vectis-test/vars.fd",
        imageName: "Windows 11 Pro",
        acceptLicense: true,
      },
    };
    store.put(kind, "setup", { ...setup, phase: "interrupted" });
    try {
      const linux = service.submit("linux", {
        type: "environment.prepare-linux",
        ...setup.configuration,
      });
      const mac = service.submit("mac", {
        type: "environment.install-macos",
        ...setup.configuration,
        restorePath: "/isolated-vectis-test/restore.ipsw",
      });
      await service.drain();
      expect(store.get("operation", linux.id)).toMatchObject({
        result: { code: "environment_exists" },
      });
      expect(store.get("operation", mac.id)).toMatchObject({
        result: { code: "installation_exists" },
      });
      expect(store.list(kind)).toHaveLength(1);
      expect(store.snapshot().environments).toHaveLength(0);
    } finally {
      await service.close();
      store.close();
    }
  },
);
