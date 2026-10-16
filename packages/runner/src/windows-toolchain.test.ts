import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { provisionScript } from "./provision-scripts.js";
import { windowsSeed } from "./windows-seed.js";
import {
  windowsDefenderBootScript,
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
  expect(script).toContain("$toolPaths + $minGitPaths");
  expect(script).toContain("$binaries.Count -ne 1");
});

test("Windows provisioning verifies effective security settings and records protected services", () => {
  const script = windowsToolchainScript();
  for (const step of [
    "toolchain-admin-check",
    "defender-tamper-check",
    "defender-policy",
    "defender-preferences",
    "defender-verify",
    "defender-exclusion-fallback",
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
    "defender-startup-task",
    "defender-boot-verification-pending",
  ])
    expect(script).toContain(`vectis-provision: ${step}`);
  expect(script).toContain(
    "Set-MpPreference -DisableRealtimeMonitoring $true -DisableBehaviorMonitoring $true -DisableIOAVProtection $true -DisableScriptScanning $true -MAPSReporting 0 -SubmitSamplesConsent 2",
  );
  expect(script).toContain("$defenderStatus.RealTimeProtectionEnabled -ne $false");
  expect(script).toContain("$defenderStatus.IsTamperProtected");
  expect(script).toContain("Add-MpPreference -ExclusionPath 'C:\\'");
  expect(script).toContain("@($defenderPreferences.ExclusionPath) -notcontains 'C:\\'");
  expect(script).toContain("throw 'Defender remains enabled");
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

test("the persistent SYSTEM startup check uses the same Defender policy and records the current boot", () => {
  const script = windowsToolchainScript();
  const boot = windowsDefenderBootScript();
  const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toBe(boot);
  expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
  expect(script).toContain("-User SYSTEM -RunLevel Highest -Force");
  expect(boot).toContain("LastBootUpTime.ToUniversalTime().ToString('o')");
  expect(boot).toContain("Status = 'verified'; BootTime = $bootTime");
  expect(boot).toContain("Status = 'failed'; BootTime = $bootTime");
  expect(boot).toContain("vectis-provision: defender-boot-verified");
  expect(boot).toContain("throw 'HVCI is still enabled after boot.'");
  expect(boot).toContain("did not stay disabled after boot");
  const policyStart = script.indexOf("vectis-provision: defender-tamper-check");
  const policyEnd = script.indexOf("vectis-provision: windows-update-policy");
  expect(boot).toContain(
    script
      .slice(
        script.lastIndexOf("Write-Output", policyStart),
        script.lastIndexOf("Write-Output", policyEnd),
      )
      .trim(),
  );
});

const hasPowerShell =
  spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status ===
  0;
const scripts = [
  windowsToolchainScript(),
  windowsDefenderBootScript(),
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
