import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  provisionScript,
  provisionShutdownScript,
  runnerPreinstallScript,
  setupUploadScripts,
} from "./provision-scripts.js";
import { runnerDistribution, runnerVersion } from "./runner-release.js";

test.each(["linux", "macos", "windows"] as const)(
  "%s preinstallation pins the release, retries downloads and verifies before extraction",
  (os) => {
    const script = runnerPreinstallScript(os);
    const distribution = runnerDistribution(os);
    expect(script).toContain(distribution.url);
    expect(script).toContain(distribution.sha256);
    expect(script).toContain(runnerVersion);
    expect(script).toContain(".vectis-installed");
    expect(script.indexOf(distribution.sha256)).toBeLessThan(
      script.indexOf(os === "windows" ? "Expand-Archive" : "tar xzf"),
    );
    if (os === "windows") {
      expect(script).toContain("$attempt -le 4");
      expect(script).toContain("Invoke-WebRequest -UseBasicParsing");
      expect(provisionScript(os, { runner: true, setup: true, user: "vectis" })).toContain(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $setup",
      );
      expect(provisionScript(os, { runner: false, setup: true, user: "vectis" })).not.toMatch(
        /pwsh|bash/,
      );
    } else {
      expect(script).toContain("--retry 3");
      if (os === "linux") expect(script).toContain('sudo -n "$target/bin/installdependencies.sh"');
      else expect(script).not.toContain("sudo");
      for (const shell of [
        script,
        provisionScript(os, { runner: true, setup: true, user: "vectis" }),
        provisionShutdownScript(os),
      ])
        expect(spawnSync("/bin/bash", ["-n"], { input: shell, encoding: "utf8" }).status).toBe(0);
    }
  },
);

test("setup text travels as bounded data chunks and executes only from its decoded guest file", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-setup-data-"));
  try {
    const setup =
      "# Unicode: é漢\nprintf '%s' 'literal $(touch injected) `touch injected2`' > \"$HOME/result\"\n" +
      "# padding\n".repeat(6000);
    const scripts = setupUploadScripts("linux", setup);
    expect(scripts.length).toBeGreaterThan(2);
    expect(scripts.every((script) => Buffer.byteLength(script) <= 65536)).toBe(true);
    expect(scripts.join("\n")).not.toContain("touch injected");
    for (const script of [
      ...scripts,
      provisionScript("linux", { runner: false, setup: true, user: "vectis" }),
    ]) {
      const result = spawnSync("/bin/bash", ["-s"], {
        input: script,
        env: { ...process.env, HOME: home },
        cwd: home,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(await readFile(join(home, "result"), "utf8")).toBe(
      "literal $(touch injected) `touch injected2`",
    );
    await expect(readFile(join(home, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "injected2"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => setupUploadScripts("windows", "é".repeat(32769))).toThrow("64 KiB");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux freeze clears the provision VM identity while preserving the instance identity unit", () => {
  const script = provisionShutdownScript("linux");
  expect(script).toContain(
    "rm -f /etc/ssh/ssh_host_* /etc/vectis/instance-id /var/lib/dbus/machine-id",
  );
  expect(script).toContain("printf 'uninitialized\\n' > /etc/machine-id");
  expect(script.indexOf("sync")).toBeLessThan(script.indexOf("poweroff"));
});
