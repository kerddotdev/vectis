import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.js";
import { discardMacInstallation } from "./macos-discard.js";
import { activityFor } from "./activities.js";
import { Service } from "./service.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vectis-discard-"));
  const store = new Store(":memory:");
  const directory = join(root, "vectis-mac-install");
  const configuration = {
    id: "mac",
    name: "Mac",
    cpu: 2,
    memoryMiB: 4096,
    diskGiB: 64,
    imageDirectory: root,
    storagePath: root,
    restorePath: join(root, "restore.ipsw"),
  };
  await mkdir(directory);
  await writeFile(join(directory, "setup.json"), JSON.stringify({ id: "install", configuration }));
  await writeFile(configuration.restorePath, "keep source");
  const record = {
    id: "setup",
    attemptId: "console",
    directory,
    configuration,
    phase: "setup_required",
  };
  store.put("macInstallation", "setup", record);
  return {
    root,
    store,
    directory,
    record,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("discard uses immutable disk ownership after a later console attempt and preserves the source", async () => {
  const f = await fixture();
  try {
    const operation = f.store.accept(
      "install",
      "install",
      "environment.install-macos",
      activityFor("install", { type: "environment.resume-macos", id: "setup" }),
    ).operation;
    f.store.update(operation, { status: "action_required", result: { setupId: "setup" } });
    await expect(discardMacInstallation(f.store, "setup", "wrong")).rejects.toMatchObject({
      code: "confirmation_mismatch",
    });
    await discardMacInstallation(f.store, "setup", "mac");
    expect(f.store.get("macInstallation", "setup")).toBeUndefined();
    expect(f.store.get("operation", operation.id)).toMatchObject({ status: "cancelled" });
    expect(f.store.snapshot().activities?.find((item) => item.id === "setup")?.status).toBe(
      "cancelled",
    );
    expect(await readFile(f.record.configuration.restorePath, "utf8")).toBe("keep source");
    await expect(readFile(join(f.directory, "setup.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});

test("a successful discard command cancels only the preparation intent", async () => {
  const f = await fixture();
  const service = new Service(f.store, new VmRuntime({ home: f.root }));
  try {
    const install = f.store.accept(
      "install",
      "install",
      "environment.install-macos",
      activityFor("install", { type: "environment.resume-macos", id: "setup" }),
    ).operation;
    f.store.update(install, { status: "action_required", result: { setupId: "setup" } });
    const discard = service.submit("discard", {
      type: "environment.discard-macos",
      id: "setup",
      environmentId: "mac",
    });
    await service.drain();
    const snapshot = service.snapshot();
    const operation = snapshot.operations.find((item) => item.id === discard.id);
    expect(operation).toMatchObject({
      status: "succeeded",
      activityId: "setup",
      result: { setupId: "setup" },
    });
    expect(snapshot.activities?.find((item) => item.id === "setup")).toMatchObject({
      status: "cancelled",
      message: "The unregistered macOS setup was explicitly discarded.",
      completedAt: operation?.updatedAt,
    });
    expect(snapshot.operations.find((item) => item.id === install.id)?.status).toBe("cancelled");
    expect(await readFile(f.record.configuration.restorePath, "utf8")).toBe("keep source");
  } finally {
    await service.close();
    await f.close();
  }
});

test("discard rejects active or registered setup, foreign markers, and symlink directories", async () => {
  const f = await fixture();
  try {
    for (const phase of ["installing", "setup_running", "registered"]) {
      f.store.put("macInstallation", "setup", { ...f.record, phase });
      await expect(discardMacInstallation(f.store, "setup", "mac")).rejects.toMatchObject({
        code: "installation_in_use",
      });
    }
    f.store.put("macInstallation", "setup", f.record);
    await writeFile(
      join(f.directory, "setup.json"),
      JSON.stringify({ id: "foreign", configuration: f.record.configuration }),
    );
    await expect(discardMacInstallation(f.store, "setup", "mac")).rejects.toMatchObject({
      code: "setup_directory_conflict",
    });
    await rm(f.directory, { recursive: true });
    await symlink(f.root, f.directory);
    await expect(discardMacInstallation(f.store, "setup", "mac")).rejects.toMatchObject({
      code: "setup_directory_conflict",
    });
    expect(await readFile(f.record.configuration.restorePath, "utf8")).toBe("keep source");
  } finally {
    await f.close();
  }
});

test("discard preserves registered images reached through a different symlink path", async () => {
  const f = await fixture();
  try {
    const image = join(f.directory, "another-image.img");
    const alias = join(f.root, "image-alias.img");
    await writeFile(image, "registered image");
    await symlink(image, alias);
    f.store.put("environment", "other", {
      id: "other",
      name: "Other",
      os: "linux",
      state: "ready",
      basePath: alias,
      cpu: 2,
      memoryMiB: 4096,
    });
    await expect(discardMacInstallation(f.store, "setup", "mac")).rejects.toMatchObject({
      code: "installation_in_use",
    });
    expect(await readFile(alias, "utf8")).toBe("registered image");
  } finally {
    await f.close();
  }
});
