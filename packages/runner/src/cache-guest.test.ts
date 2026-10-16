import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { cachePrivilegeScript, cacheSetupScript, cacheUnmountScript } from "./cache-guest.js";
import { runnerStartScript } from "./runner-release.js";

const access = { repositoryId: 2, actors: "any", approval: "automatic" } as const;
test.each(["linux", "macos"] as const)("%s cache probe requires noninteractive sudo", (os) => {
  for (const exitCode of [0, 1]) {
    const result = spawnSync("bash", ["-s"], {
      input: `sudo() { test "$*" = '-n true' || return 99; return ${exitCode}; }\n${cachePrivilegeScript(os)}`,
      encoding: "utf8",
    });
    expect(result.status).toBe(exitCode);
  }
});

test("Windows cache probe checks the effective administrator token", () => {
  const script = cachePrivilegeScript("windows");
  expect(script).toContain("WindowsIdentity]::GetCurrent()");
  expect(script).toContain("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
  expect(script).toContain("exit 1");
});
test.each(["linux", "macos", "windows"] as const)(
  "%s cache setup identifies the disk, formats first use and exports job caches",
  (os) => {
    const setup = cacheSetupScript(os, 20);
    expect(setup).toContain("VECTISCACHE");
    expect(setup).toContain(String(20 * 1024 ** 3));
    for (const variable of [
      "RUNNER_TOOL_CACHE",
      "npm_config_cache",
      "npm_config_store_dir",
      "YARN_CACHE_FOLDER",
      "PIP_CACHE_DIR",
      "GOMODCACHE",
      "GOCACHE",
    ])
      expect(setup).toContain(variable);
    expect(setup).not.toContain("CARGO_HOME");
    const start = runnerStartScript(os, "c2VjcmV0", access, { cacheSizeGiB: 20 });
    expect(start.indexOf(setup)).toBeLessThan(start.indexOf("--jitconfig"));
    expect(runnerStartScript(os, "c2VjcmV0", access)).not.toContain(setup);
    if (os === "linux") {
      expect(setup).toContain('if test -z "$filesystem"');
      expect(setup).toContain("mkfs.ext4");
      expect(setup).toContain("virtio-VECTISCACHE");
      expect(setup).toContain("nodev,nosuid");
    }
    if (os === "macos") {
      expect(setup).toContain('test "$candidate" != "$boot_disk"');
      expect(setup).toContain("diskutil eraseDisk APFS VECTISCACHE");
      expect(setup).toContain("PhysicalStores:1");
    }
    if (os === "windows") {
      expect(setup).toContain("$disk.IsBoot -or $disk.IsSystem");
      expect(setup).toContain("$disk.PartitionStyle -eq 'RAW'");
      expect(setup).toContain("Initialize-Disk");
      expect(setup).toContain("Format-Volume -FileSystem NTFS");
    } else {
      expect(spawnSync("bash", ["-n"], { input: start, encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync("bash", ["-n"], { input: cacheUnmountScript(os), encoding: "utf8" }).status,
      ).toBe(0);
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "macOS formats only a unique blank non-boot disk and rejects unsafe layouts",
  async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "vectis-cache-diskutil-"));
    const bin = join(home, "bin");
    await mkdir(bin);
    const trace = join(home, "trace");
    const encode = (value: unknown): string => {
      if (typeof value === "number") return `<integer>${value}</integer>`;
      if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
      if (typeof value === "string") return `<string>${value}</string>`;
      if (Array.isArray(value)) return `<array>${value.map(encode).join("")}</array>`;
      if (value && typeof value === "object")
        return `<dict>${Object.entries(value)
          .map(([key, item]) => `<key>${key}</key>${encode(item)}`)
          .join("")}</dict>`;
      throw new Error("Unsupported fixture value");
    };
    await writeFile(
      join(bin, "diskutil"),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
const fixtures = JSON.parse(fs.readFileSync(process.env.FIXTURES, 'utf8'));
fs.appendFileSync(process.env.TRACE, args + '\\n');
if (!(args in fixtures)) process.exit(1);
process.stdout.write(fixtures[args]);
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, "sudo"),
      `#!${process.execPath}
require('node:fs').appendFileSync(process.env.TRACE, 'sudo ' + process.argv.slice(2).join(' ') + '\\n');
`,
      { mode: 0o700 },
    );
    const script = cacheSetupScript("macos", 20).split("export RUNNER_TOOL_CACHE=")[0];
    if (!script) throw new Error("Missing cache setup");
    try {
      for (const mode of [
        "blank",
        "multiple-boot-stores",
        "ambiguous",
        "wrong-size",
        "unknown-content",
      ] as const) {
        await writeFile(trace, "");
        const physical =
          mode === "multiple-boot-stores"
            ? [{ DeviceIdentifier: "disk0s2" }, { DeviceIdentifier: "disk2s2" }]
            : [{ DeviceIdentifier: "disk0s2" }];
        const fixtures = {
          "info -plist /": { APFSContainerReference: "disk3" },
          "apfs list -plist disk3": { Containers: [{ PhysicalStores: physical }] },
          "info -plist disk0s2": { ParentWholeDisk: "disk0" },
          "list -plist physical": {
            AllDisksAndPartitions: [
              { DeviceIdentifier: "disk0" },
              { DeviceIdentifier: "disk1" },
              ...(mode === "ambiguous" ? [{ DeviceIdentifier: "disk2" }] : []),
            ],
          },
          "info -plist disk1": {
            WholeDisk: true,
            TotalSize: (mode === "wrong-size" ? 21 : 20) * 1024 ** 3,
          },
          "info -plist disk2": { WholeDisk: true, TotalSize: 20 * 1024 ** 3 },
          "list -plist disk1": {
            AllDisksAndPartitions: [{ Content: mode === "unknown-content" ? "unknown" : "" }],
          },
          "info -plist VECTISCACHE": {
            APFSContainerReference: "disk4",
            DeviceIdentifier: "disk4s1",
          },
          "apfs list -plist disk4": {
            Containers: [{ PhysicalStores: [{ DeviceIdentifier: "disk1s2" }] }],
          },
          "info -plist disk1s2": { ParentWholeDisk: "disk1" },
          "mount disk4s1": {},
          "info -plist disk4s1": { MountPoint: "/Volumes/VECTISCACHE", VolumeName: "VECTISCACHE" },
        };
        const path = join(home, "fixtures.json");
        await writeFile(
          path,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(fixtures).map(([key, value]) => [
                key,
                `<?xml version="1.0"?><plist version="1.0">${encode(value)}</plist>`,
              ]),
            ),
          ),
        );
        const result = spawnSync("/bin/bash", ["-s"], {
          input: script,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            TMPDIR: home,
            FIXTURES: path,
            TRACE: trace,
          },
        });
        const calls = await readFile(trace, "utf8");
        if (mode === "blank") {
          expect(result.status, result.stderr).toBe(0);
          expect(calls).toContain("sudo -n diskutil eraseDisk APFS VECTISCACHE disk1");
        } else {
          expect(result.status).not.toBe(0);
          expect(calls).not.toContain("sudo ");
        }
        expect(calls).not.toContain("eraseDisk APFS VECTISCACHE disk0");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
