import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runtimeDiagnostics } from "./diagnostics.js";

test("doctor distinguishes configured paths from existing executable files and gives a fix", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-doctor-"));
  try {
    const helper = join(home, "helper");
    await writeFile(helper, "synthetic test executable", { mode: 0o600 });
    const options = { home, appleHelper: helper, keychainHelper: join(home, "missing") };
    const before = runtimeDiagnostics(options, "service");
    expect(before.configured.appleHelper).toBe(true);
    expect(before.checks).toContainEqual(
      expect.objectContaining({
        id: "runtime.appleHelper",
        status: "blocked",
        code: "runtime_component_missing",
        nextStep: expect.stringContaining("VECTIS_APPLE_HELPER"),
      }),
    );
    expect(before.checks).toContainEqual(
      expect.objectContaining({ id: "runtime.keychainHelper", code: "runtime_component_missing" }),
    );
    expect(before.checks).toContainEqual(expect.objectContaining({ id: "home", status: "ok" }));
    await chmod(helper, 0o700);
    expect(runtimeDiagnostics(options, "service").checks).toContainEqual(
      expect.objectContaining({ id: "runtime.appleHelper", status: "ok" }),
    );
    expect(runtimeDiagnostics({ home, appleHelper: home }, "service").checks).toContainEqual(
      expect.objectContaining({ id: "runtime.appleHelper", code: "runtime_component_missing" }),
    );
    await chmod(home, 0o500);
    expect(runtimeDiagnostics(options, "service").checks).toContainEqual(
      expect.objectContaining({
        id: "home",
        status: "blocked",
        code: "home_not_writable",
        nextStep: expect.any(String),
      }),
    );
  } finally {
    await chmod(home, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

test("missing Windows components need attention until a Windows environment exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-doctor-windows-"));
  try {
    const ids = ["runtime.qemu", "runtime.qemuImg", "runtime.swtpm"];
    const linux = runtimeDiagnostics({ home }, "service", [{ os: "linux" }]);
    expect(
      linux.checks.filter((check) => ids.includes(check.id)).map((check) => check.status),
    ).toEqual(["attention", "attention", "attention"]);
    const windows = runtimeDiagnostics({ home }, "service", [{ os: "windows" }]);
    expect(
      windows.checks.filter((check) => ids.includes(check.id)).map((check) => check.status),
    ).toEqual(["blocked", "blocked", "blocked"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
