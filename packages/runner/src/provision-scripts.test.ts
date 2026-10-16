import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  provisionScript,
  provisionLinuxIdentityResetScript,
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
      expect(provisionScript(os, { runner: true, setup: true })).toContain(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $setup",
      );
      expect(provisionScript(os, { runner: false, setup: true })).not.toMatch(/pwsh|bash/);
    } else {
      expect(script).toContain("--retry 3");
      if (os === "linux") {
        expect(script).toContain('sudo -n "$target/bin/installdependencies.sh"');
        expect(script).not.toMatch(/sudo -n (install|chown)/);
      } else expect(script).not.toContain("sudo");
      for (const shell of [
        script,
        provisionScript(os, { runner: true, setup: true }),
        provisionShutdownScript(os),
      ])
        expect(spawnSync("/bin/bash", ["-n"], { input: shell, encoding: "utf8" }).status).toBe(0);
    }
  },
);

test.each([
  { name: "prepared image without sudo", ready: true, expected: 0 },
  { name: "missing linked library without sudo", mode: "linked", expected: 1 },
  { name: "missing ICU without sudo", mode: "icu", expected: 1 },
  { name: "failed ldd probe without sudo", mode: "ldd-error", expected: 1 },
  { name: "missing libraries installed with sudo", mode: "linked", sudo: true, expected: 0 },
  { name: "installer failure", mode: "linked", sudo: true, installExit: 42, expected: 42 },
  {
    name: "installer leaves missing libraries",
    mode: "linked",
    sudo: true,
    unresolved: true,
    expected: 1,
  },
  { name: "download failure", ready: true, downloadExit: 22, expected: 22 },
])("Linux preinstallation: $name", async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-preinstall-"));
  const target = join(home, ".vectis-runner", runnerVersion);
  try {
    if (scenario.ready) await writeFile(join(home, "dependencies-ready"), "");
    const stubs = `
curl() { touch "$target/runner.tar.gz"; return ${scenario.downloadExit ?? 0}; }
sha256sum() { cat >/dev/null; }
tar() {
  mkdir -p "$target/bin"
  touch "$target/bin/Runner.Listener"
  chmod +x "$target/bin/Runner.Listener"
}
ldd() {
  if ! test -f "$HOME/dependencies-ready"; then
    case '${scenario.mode ?? ""}' in
      linked) echo 'libmissing.so => not found'; return 0 ;;
      ldd-error) echo 'ldd probe failed' >&2; return 2 ;;
    esac
  fi
  echo 'libc.so => /lib/libc.so'
}
ldconfig() {
  for library in libicuuc libssl libcrypto libkrb5 libz liblttng-ust; do
    if test "$library" = libicuuc && test '${scenario.mode ?? ""}' = icu && ! test -f "$HOME/dependencies-ready"; then continue; fi
    printf '  %s.so.1 => /lib/%s.so.1\\n' "$library" "$library"
  done
}
sudo() {
  echo "test-sudo: $*"
  test "$1" = -n || return 97
  shift
  if test "$1" = true; then return ${scenario.sudo ? 0 : 1}; fi
  test "$1" = "$target/bin/installdependencies.sh" || return 98
  ${scenario.unresolved ? ":" : 'touch "$HOME/dependencies-ready"'}
  return ${scenario.installExit ?? 0}
}
`;
    const result = spawnSync("/bin/bash", ["-s"], {
      input: stubs + runnerPreinstallScript("linux"),
      env: { ...process.env, HOME: home },
      cwd: home,
      encoding: "utf8",
    });
    expect(result.status, result.stderr + result.stdout).toBe(scenario.expected);
    if (scenario.expected === 0) {
      expect(await readFile(join(target, ".vectis-installed"), "utf8")).toBe(`${runnerVersion}\n`);
      expect(result.stdout).toContain("vectis-provision: installed");
    } else {
      await expect(stat(join(target, ".vectis-installed"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.stdout).not.toContain("vectis-provision: installed");
    }
    if (scenario.ready && !scenario.downloadExit) {
      expect(result.stdout).toContain("vectis-provision: dependencies-present");
      expect(result.stdout).not.toContain("test-sudo:");
    }
    if (!scenario.ready && !scenario.sudo) {
      expect(result.stderr).toContain(
        "dependencies are missing and passwordless sudo is unavailable",
      );
      expect(result.stdout).not.toContain("test-sudo: -n /");
    }
    if (scenario.installExit) expect(result.stdout).not.toContain("dependencies-verify");
    if (scenario.downloadExit) {
      expect(result.stdout).toContain("vectis-provision: download");
      expect(result.stdout).not.toContain("vectis-provision: checksum");
    }
    if (scenario.unresolved) expect(result.stderr).toContain("still missing after installation");
    if (scenario.mode === "icu")
      expect(result.stderr).toContain("Missing runner system library: libicuuc");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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
    for (const script of [...scripts, provisionScript("linux", { runner: false, setup: true })]) {
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

test("Linux identity reset clears persistent identifiers without shutting down or removing boot units", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-identity-reset-"));
  try {
    const files = [
      "etc/ssh/ssh_host_ed25519_key",
      "etc/ssh/ssh_host_rsa_key",
      "etc/vectis/instance-id",
      "var/lib/dbus/machine-id",
    ];
    await Promise.all(
      ["etc/ssh", "etc/vectis", "var/lib/dbus", "etc/systemd/system"].map((path) =>
        mkdir(join(home, path), { recursive: true }),
      ),
    );
    for (const path of [
      ...files,
      "etc/machine-id",
      "etc/systemd/system/vectis-instance-identity.service",
    ])
      await writeFile(join(home, path), "provisioning-boot-identity");
    const script = provisionLinuxIdentityResetScript()
      .replaceAll("/etc/", `${home}/etc/`)
      .replaceAll("/var/lib/", `${home}/var/lib/`);
    const result = spawnSync("/bin/bash", ["-s"], {
      input: `
sudo() { test "$1" = -n || return 97; shift; "$@"; }
sync() { echo 'synced'; }
poweroff() { echo 'unexpected poweroff'; exit 98; }
export -f sync poweroff
${script}`,
      encoding: "utf8",
      cwd: home,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("synced");
    expect(result.stdout).not.toContain("unexpected");
    for (const path of files)
      await expect(stat(join(home, path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "etc/machine-id"), "utf8")).toBe("uninitialized\n");
    expect(
      await readFile(join(home, "etc/systemd/system/vectis-instance-identity.service"), "utf8"),
    ).toBe("provisioning-boot-identity");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux identity reset stops at a failing privileged cleanup step", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-shutdown-"));
  try {
    const script = provisionLinuxIdentityResetScript()
      .replaceAll("/etc/", `${home}/etc/`)
      .replaceAll("/var/lib/", `${home}/var/lib/`);
    const result = spawnSync("/bin/bash", ["-s"], {
      input: `
sudo() { test "$1" = -n || return 97; shift; "$@"; }
rm() { echo 'synthetic identity cleanup failed' >&2; return 23; }
sync() { echo 'unexpected sync'; }
poweroff() { echo 'unexpected poweroff'; }
export -f rm sync poweroff
${script}`,
      encoding: "utf8",
      cwd: home,
    });
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("synthetic identity cleanup failed");
    expect(result.stdout).toContain("vectis-provision: clear-identity");
    expect(result.stdout).not.toContain("vectis-provision: sync");
    expect(result.stdout).not.toContain("unexpected");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
