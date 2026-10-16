import { expect, test } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsSeed } from "./windows-seed.js";
import { runnerPreinstallScript } from "./provision-scripts.js";
import { windowsGit, windowsToolchainScript } from "./windows-toolchain.js";
import { windowsDefenderCommands } from "./windows-defender.js";

const configuration = {
  id: "isolated-setup",
  password: "Generated-local-test-password-42!",
  imageName: "Windows 11 Pro",
  acceptLicense: true,
};
test("fresh Windows images share toolchain provisioning and bootstrap the runner with Windows PowerShell", () => {
  const { script } = windowsSeed(configuration);
  expect(script).toContain(runnerPreinstallScript("windows"));
  expect(script).toContain("$stage = 'runner-preinstall'");
  expect(script).toContain(windowsToolchainScript());
  expect(script).toContain("$stage = 'windows-toolchain'");
});

test("fresh installation starts separate Defender processes before the toolchain without embedding their cmdlets", () => {
  const { script, defenderScripts } = windowsSeed(configuration);
  const commands = windowsDefenderCommands();
  expect(defenderScripts).toHaveLength(commands.length);
  expect(script).not.toMatch(/(?:Add|Set|Get)-Mp/);
  let previous = script.indexOf("$stage = 'windows-defender'");
  expect(previous).toBeGreaterThan(-1);
  for (const [index, command] of commands.entries()) {
    const file = defenderScripts[index];
    expect(file?.contents).toContain(command.script);
    expect(command.shell).toBe("cmd");
    const launch = `& cmd.exe /d /c ('"' + (Join-Path $PSScriptRoot '${file?.name}') + '"')`;
    const position = script.indexOf(launch);
    expect(position).toBeGreaterThan(previous);
    const next = script.slice(position + launch.length).split("\n")[1];
    expect(next).toContain(command.allowFailure ? "Write-Warning" : "throw");
    previous = position;
  }
  expect(script.indexOf("$stage = 'windows-toolchain'")).toBeGreaterThan(previous);
});

test("Windows answer media requires explicit license acceptance and safe script identifiers", () => {
  expect(() => windowsSeed({ ...configuration, acceptLicense: false })).toThrow(/license terms/);
  expect(() => windowsSeed({ ...configuration, id: "'; Invoke-Expression '" })).toThrow();
  expect(() => windowsSeed({ ...configuration, password: "short" })).toThrow();
  expect(() => windowsSeed({ ...configuration, imageName: "Windows\u0000Pro" })).toThrow();
});

test("fresh Windows images verify the pinned Git download before launching its installer", () => {
  const { script } = windowsSeed(configuration);
  const download = script.indexOf(windowsGit.url);
  const verify = script.indexOf(windowsGit.sha256);
  const use = script.indexOf("Start-Process -FilePath $installer");
  expect(download).toBeGreaterThan(-1);
  expect(verify).toBeGreaterThan(download);
  expect(use).toBeGreaterThan(verify);
  expect(script).toContain('throw "Tool checksum mismatch: $Url"');
  expect(script).toContain("Invoke-WebRequest -UseBasicParsing");
  expect(script).toContain("$gitRoot = 'C:\\Program Files\\Git'");
  expect(script).not.toContain("MinGit-2.");
});

test("answer-file values cannot inject XML or leak the password into the bootstrap script", () => {
  const password = "Local<&\"'password-for-test-42!";
  const imageName = "Windows <edition> & example";
  const { answer, script } = windowsSeed({ ...configuration, password, imageName });
  expect(answer).toContain("Local&lt;&amp;&quot;&apos;password-for-test-42!");
  expect(answer).toContain("Windows &lt;edition&gt; &amp; example");
  expect(answer).not.toContain(password);
  expect(script).not.toContain(password);
  const command = answer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  expect(command).toBeDefined();
  const launch = Buffer.from(command ?? "", "base64").toString("utf16le");
  expect(launch).toContain("VECTIS_SETUP");
  expect(launch).not.toContain(password);
});

const hasPowerShell =
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status ===
  0;

test.skipIf(!hasPowerShell).each(["none", "optional", "exclusion-policy", "exclusion-path"])(
  "seed executes separate command files and handles %s failure",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "vectis-seed-defender-"));
    try {
      const { script, defenderScripts } = windowsSeed(configuration);
      for (const file of defenderScripts)
        await writeFile(join(directory, file.name), file.contents);
      const setup = script.slice(
        script.indexOf("  $stage = 'windows-defender'"),
        script.indexOf("  $stage = 'windows-toolchain'"),
      );
      const failedIndex =
        failure === "exclusion-policy" ? 0 : failure === "exclusion-path" ? 1 : -1;
      const wrapper = join(directory, "test.ps1");
      await writeFile(
        wrapper,
        String.raw`$ErrorActionPreference = 'Stop'
$script:count = 0
function Invoke-TestCommand($File) {
  $name = [IO.Path]::GetFileName($File.Trim('"'))
  $index = [int]($name -replace '^defender-(\d+)\..*$', '$1')
  if ($index -ne $script:count) { throw 'Commands ran out of order' }
  $contents = Get-Content -LiteralPath (Join-Path $PSScriptRoot $name) -Raw
  if ($name -like '*.cmd' -and $contents -notmatch 'reg.exe add') { throw 'Registry command missing' }
  Write-Output "executed=$index"
  $script:count++
  $global:LASTEXITCODE = 0
  if ($index -eq ${failedIndex} -or ('${failure}' -eq 'optional' -and $index -ge 2)) { $global:LASTEXITCODE = 1 }
}
function cmd.exe {
  if ($args[0] -ne '/d' -or $args[1] -ne '/c') { throw 'Expected cmd shell' }
  Invoke-TestCommand $args[-1]
}
${setup}
Write-Output 'toolchain-next'
`,
      );
      const result = spawnSync(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", wrapper],
        { encoding: "utf8", timeout: 10000 },
      );
      const shouldFail = failedIndex >= 0;
      expect(result.status, result.stderr).toBe(shouldFail ? 1 : 0);
      expect(result.stdout.includes("toolchain-next")).toBe(!shouldFail);
      const count = shouldFail ? failedIndex + 1 : defenderScripts.length;
      expect(result.stdout.match(/executed=\d+/g)).toEqual(
        Array.from({ length: count }, (_, index) => `executed=${index}`),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPowerShell).each([false, true])(
  "bootstrap records failure and clears stale completion even if diagnostics cannot be written: %s",
  async (failDiagnostics) => {
    const directory = await mkdtemp(join(tmpdir(), "vectis-bootstrap-script-"));
    const root = join(directory, "ProgramData", "Vectis");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "prepared"), configuration.id);
      await writeFile(join(root, "failed"), "old failure");
      await writeFile(join(root, "diagnostic.json"), '{"stage":"old"}');
      const wrapper = join(directory, "test.ps1");
      const script = windowsSeed(configuration).script.replace(
        "$root = 'C:\\ProgramData\\Vectis'",
        "$root = Join-Path $TestDrive 'ProgramData/Vectis'",
      );
      expect(script).not.toContain("$root = 'C:\\ProgramData\\Vectis'");
      await writeFile(
        wrapper,
        String.raw`param([string]$TestDrive)
$env:PROCESSOR_ARCHITECTURE = 'ARM64'
function Set-ItemProperty {}
function Remove-ItemProperty {}
function Set-TimeZone {}
function Set-Service {}
function Start-Service {}
function Set-LocalUser {}
function Add-WindowsCapability { throw 'Synthetic capability installation failure' }
` +
          (failDiagnostics
            ? String.raw`
function Set-Content {
  param([Parameter(Position=0)]$Path, [Parameter(ValueFromPipeline=$true)]$Value, $Encoding)
  process {
    if ($Path -like '*diagnostic.json') { throw 'Synthetic diagnostic write failure' }
    Microsoft.PowerShell.Management\Set-Content -Path $Path -Value $Value -Encoding $Encoding
  }
}
`
            : "") +
          script,
      );
      await expect(
        promisify(execFile)(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", wrapper, directory],
          {
            timeout: 10000,
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Synthetic capability installation failure"),
      });
      expect(await readFile(join(root, "failed"), "utf8")).toMatch(/^ssh-installation\s*$/);
      if (failDiagnostics) {
        await expect(readFile(join(root, "diagnostic.json"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(
          JSON.parse(
            (await readFile(join(root, "diagnostic.json"), "utf8")).replace(/^\uFEFF/, ""),
          ),
        ).toMatchObject({
          stage: "ssh-installation",
          message: "Synthetic capability installation failure",
          line: expect.any(Number),
        });
      }
      await expect(readFile(join(root, "prepared"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
