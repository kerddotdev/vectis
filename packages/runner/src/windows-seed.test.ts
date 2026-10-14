import { expect, test } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsGit, windowsSeed } from "./windows-seed.js";

const configuration = {
  id: "isolated-setup",
  password: "Generated-local-test-password-42!",
  imageName: "Windows 11 Pro",
  acceptLicense: true,
};

test("Windows answer media requires explicit license acceptance and safe script identifiers", () => {
  expect(() => windowsSeed({ ...configuration, acceptLicense: false })).toThrow(/license terms/);
  expect(() => windowsSeed({ ...configuration, id: "'; Invoke-Expression '" })).toThrow();
  expect(() => windowsSeed({ ...configuration, password: "short" })).toThrow();
  expect(() => windowsSeed({ ...configuration, imageName: "Windows\u0000Pro" })).toThrow();
});

test("guest git is checked against its pinned hash before anything uses it", () => {
  const { script } = windowsSeed(configuration);
  const download = script.indexOf(windowsGit.url);
  const verify = script.indexOf(windowsGit.sha256);
  const use = script.indexOf("git.exe");
  expect(download).toBeGreaterThan(-1);
  expect(verify).toBeGreaterThan(download);
  expect(use).toBeGreaterThan(verify);
  expect(script).toContain("throw 'Git checksum mismatch'");
  expect(script).toContain("Invoke-WebRequest -UseBasicParsing");
  expect(script).toContain("$gitRoot = 'C:\\Program Files\\MinGit'");
  expect(script).not.toContain("$gitRoot = 'C:\\Program Files\\Git'");
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
      ).rejects.toMatchObject({ code: 1 });
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
