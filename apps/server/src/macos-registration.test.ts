import { expect, test } from "vitest";
import { Store } from "./store.js";
import { completeMacRegistration } from "./macos-registration.js";
import type { Environment } from "../../../packages/protocol/src/index.js";

test("registration resolves only its own completed setup after SSH is configured", () => {
  const store = new Store(":memory:");
  try {
    store.put("macInstallation", "setup", {
      id: "setup",
      attemptId: "attempt",
      directory: "/isolated",
      phase: "setup_required",
      bundle: "/isolated/base.bundle",
      build: "test",
      configuration: {
        id: "mac",
        name: "Mac",
        cpu: 2,
        memoryMiB: 4096,
        diskGiB: 64,
        imageDirectory: "/isolated",
        storagePath: "/isolated",
        restorePath: "/isolated/restore.ipsw",
      },
    });
    const op = store.accept("install", "install", "environment.install-macos").operation;
    store.update(op, { status: "action_required", result: { setupId: "setup" } });
    const other = store.accept("other", "other", "environment.install-macos").operation;
    store.update(other, { status: "action_required", result: { setupId: "other" } });
    const environment: Environment = {
      id: "mac",
      name: "Mac",
      os: "macos",
      state: "ready",
      basePath: "/isolated/base.bundle",
      cpu: 2,
      memoryMiB: 4096,
    };
    completeMacRegistration(store, environment);
    expect(store.get("operation", op.id)).toMatchObject({ status: "action_required" });
    const configured = {
      ...environment,
      sshUser: "vectis",
      sshKeyPath: "/isolated/key",
      knownHostsPath: "/isolated/known_hosts",
    };
    completeMacRegistration(store, { ...configured, basePath: "/isolated/other.bundle" });
    expect(store.get("operation", op.id)).toMatchObject({ status: "action_required" });
    completeMacRegistration(store, configured);
    expect(store.get("operation", op.id)).toMatchObject({ status: "succeeded" });
    expect(store.get("operation", other.id)).toMatchObject({ status: "action_required" });
    expect(store.get("macInstallation", "setup")).toMatchObject({ phase: "registered" });
  } finally {
    store.close();
  }
});
