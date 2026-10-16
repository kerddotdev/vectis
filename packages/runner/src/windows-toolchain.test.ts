import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { provisionScript } from "./provision-scripts.js";
import { windowsSeed } from "./windows-seed.js";
import {
  windowsGit,
  windowsPowerShell,
  windowsToolchainScript,
  windowsZstd,
} from "./windows-toolchain.js";

test("Windows tooling pins official ARM64 installers and the emulated x64 zstd release", () => {
  expect([windowsGit, windowsZstd, windowsPowerShell]).toEqual([
    {
      version: "2.55.0.5",
      url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-arm64.exe",
      sha256: "c955de342b1465bc637f0e71fddf4e28e8d0b829668ec1866ab32a839303e8e3",
    },
    {
      version: "1.5.7",
      url: "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip",
      sha256: "acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9",
    },
    {
      version: "7.6.6",
      url: "https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-arm64.msi",
      sha256: "387d0af8e92ba97f73616c91fa8f29a284e8f82ee6c40fe12dade971bb05bac4",
    },
  ]);
  const script = windowsToolchainScript();
  for (const release of [windowsGit, windowsZstd, windowsPowerShell]) {
    expect(script).toContain(`Get-VectisRelease '${release.url}' '${release.sha256}'`);
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(script).toContain("Get-FileHash -Algorithm SHA256 -LiteralPath $Destination");
  expect(script).toContain('throw "Tool checksum mismatch: $Url"');
  expect(script).toContain("Invoke-WebRequest -UseBasicParsing");
  expect(script).toContain("$attempt -le 4");
  expect(script).toContain("/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES");
  expect(script).toContain('/COMPONENTS="gitlfs" /o:PathOption=BashOnly');
  expect(script).toContain("$tarExe = Join-Path $gitRoot 'usr\\bin\\tar.exe'");
  expect(script).toContain("$bashExe = Join-Path $gitRoot 'bin\\bash.exe'");
  expect(script).toContain("ADD_PATH=1 USE_MU=0 ENABLE_MU=0");
  expect(script).toContain("$process.ExitCode -notin @(0, 3010)");
  expect(script).toContain("$toolPaths + $remainingPath");
  expect(script).toContain("$zstdRoot, $pwshRoot, (Join-Path $gitRoot 'usr\\bin')");
  expect(script).toContain("$toolPaths + $minGitPaths");
  expect(script).toContain("$binaries.Count -ne 1");
});

test("Windows provisioning verifies effective security settings and records protected services", () => {
  const script = windowsToolchainScript();
  for (const step of [
    "toolchain-admin-check",
    "windows-update-policy",
    "hvci",
    "git-install",
    "git-verify",
    "zstd-install-x64-emulation",
    "zstd-verify",
    "pwsh-install",
    "pwsh-verify",
    "toolchain-path",
    "toolchain-manifest",
  ])
    expect(script).toContain(`vectis-provision: ${step}`);
  expect(script).not.toMatch(/(?:Add|Set|Get)-Mp/);
  expect(script).toContain("@('wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'WSearch', 'SysMain')");
  expect(script).toContain("Set-Service -Name $serviceName -StartupType Disabled");
  expect(script).toContain("Stop-Service -Name $serviceName -Force");
  expect(script).toContain("$serviceName -notin @('UsoSvc', 'WaaSMedicSvc')");
  expect(script).toContain("-Name NoAutoUpdate -Value 1 -Type DWord");
  expect(script).toContain("Set-ItemProperty -Path $hvciPath -Name Enabled -Value 0 -Type DWord");
  expect(script).toContain("SecurityServicesRunning) -contains 2");
  expect(script).toContain("ConvertFrom-Json");
  expect(script).toContain(
    "Add-Member -NotePropertyName $name -NotePropertyValue $values[$name] -Force",
  );
});

test("provisioning removes the obsolete security startup task and receipts", () => {
  const script = windowsToolchainScript();
  expect(script).toContain(
    "Unregister-ScheduledTask -TaskName 'Vectis-VerifySecurity' -Confirm:$false",
  );
  expect(script).toContain("@('verify-security.ps1', 'security-boot.json', 'security-boot.log')");
  expect(script).toContain("$manifest.PSObject.Properties.Remove('BootVerification')");
  expect(script).not.toMatch(/Register-ScheduledTask|New-ScheduledTask|FromBase64String/);
});

const hasPowerShell =
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status ===
  0;

test.skipIf(!hasPowerShell)(
  "manifest replaces stale Defender observations with next-boot policy intent",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "vectis-toolchain-manifest-"));
    const manifestPath = join(directory, "toolchain.json");
    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          Custom: "preserved",
          Defender: { Mode: "disabled", ExclusionPath: [], RealTimeProtectionEnabled: false },
          BootVerification: "stale",
        }),
      );
      const script = windowsToolchainScript();
      const manifest = script.slice(
        script.indexOf("$manifestPath ="),
        script.indexOf("Write-Output 'vectis-provision: remove-security-startup-task'"),
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
        ],
        {
          input: String.raw`$ErrorActionPreference = 'Stop'
$toolchainRoot = $env:VECTIS_TEST_ROOT
function Get-ComputerInfo { [pscustomobject]@{ WindowsProductName = 'Windows 11'; WindowsVersion = 'test'; OsBuildNumber = 'test' } }
function Get-ItemProperty { [pscustomobject]@{ NoAutoUpdate = 1 } }
function Get-MpPreference { throw 'Defender preferences unavailable' }
function Get-MpComputerStatus { throw 'Defender status unavailable' }
${manifest}`,
          env: { ...process.env, VECTIS_TEST_ROOT: directory },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const saved = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
      expect(saved.Custom).toBe("preserved");
      expect(saved.Defender).toEqual({
        Mode: "policy-exclusion",
        PolicyExclusionPath: ["C:\\"],
        AppliesAt: "next-boot",
      });
      expect(saved).not.toHaveProperty("BootVerification");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPowerShell).each([
  { firstGit: "bin", wrongTool: "" },
  { firstGit: "cmd", wrongTool: "" },
  ...["git.exe", "bash.exe", "tar.exe", "zstd.exe", "pwsh.exe"].map((wrongTool) => ({
    firstGit: "bin",
    wrongTool,
  })),
])(
  "PATH accepts duplicate matches and validates the first tool: $firstGit / $wrongTool",
  ({ firstGit, wrongTool }) => {
    const script = windowsToolchainScript();
    const check = script.slice(
      script.indexOf("$expectedTools = @{"),
      script.indexOf("Write-Output 'vectis-provision: toolchain-manifest'"),
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
      ],
      {
        input: String.raw`$ErrorActionPreference = 'Stop'
function Join-Path($Path, $ChildPath) { "$Path\$ChildPath" }
$gitRoot = 'C:\Program Files\Git'
$gitExe = Join-Path $gitRoot 'cmd\git.exe'
$bashExe = Join-Path $gitRoot 'bin\bash.exe'
$tarExe = Join-Path $gitRoot 'usr\bin\tar.exe'
$zstdExe = 'C:\Program Files\zstd\zstd.exe'
$pwshExe = 'C:\Program Files\PowerShell\7\pwsh.exe'
function Get-Command($Name, $CommandType, [switch]$All) {
  if (!$All -or $CommandType -ne 'Application') { throw 'Expected all application matches' }
  $paths = @{
    'git.exe' = @((Join-Path $gitRoot '${firstGit}\git.exe'), $gitExe)
    'bash.exe' = @($bashExe)
    'tar.exe' = @($tarExe)
    'zstd.exe' = @($zstdExe)
    'pwsh.exe' = @($pwshExe)
  }
  if ($Name -eq '${wrongTool}') { [pscustomobject]@{ Source = "C:\unexpected\$Name" } }
  foreach ($path in $paths[$Name]) { [pscustomobject]@{ Source = $path } }
  [pscustomobject]@{ Source = "C:\later\$Name" }
}
${check}`,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(wrongTool ? 1 : 0);
    if (wrongTool) expect(result.stderr).toContain(`Unexpected tool on PATH: ${wrongTool}`);
  },
);

const scripts = [
  windowsToolchainScript(),
  windowsSeed({
    id: "parse-test",
    password: "Generated-local-test-password-42!",
    imageName: "Windows 11 Pro",
    acceptLicense: true,
  }).script,
  ...[false, true].flatMap((runner) =>
    [false, true].map((setup) => provisionScript("windows", { runner, setup })),
  ),
];

test.each(scripts.map((script, index) => ({ script, index })))(
  "Windows script $index avoids PowerShell 7-only syntax",
  ({ script }) => {
    expect(Buffer.byteLength(script, "utf8")).toBeLessThanOrEqual(65536);
    expect(script).not.toMatch(/\?\?|\?\.|&&|\|\||ForEach-Object\s+-Parallel|\?\s*[^\r\n]+\s*:/);
  },
);

test.skipIf(!hasPowerShell).each(scripts.map((script, index) => ({ script, index })))(
  "Windows script $index parses on the host without executing guest commands",
  ({ script }) => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }
`,
      ],
      { input: script, encoding: "utf8", timeout: 10000 },
    );
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  },
);
