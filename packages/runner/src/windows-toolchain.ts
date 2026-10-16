export const windowsGit = {
  version: "2.55.0.5",
  url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-arm64.exe",
  sha256: "c955de342b1465bc637f0e71fddf4e28e8d0b829668ec1866ab32a839303e8e3",
};

export const windowsZstd = {
  version: "1.5.7",
  url: "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip",
  sha256: "acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9",
};

export const windowsPowerShell = {
  version: "7.6.6",
  url: "https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-arm64.msi",
  sha256: "387d0af8e92ba97f73616c91fa8f29a284e8f82ee6c40fe12dade971bb05bac4",
};

// The startup task runs this same check because Defender preferences can reset after a reboot.
const defenderScript = String.raw`
Write-Output 'vectis-provision: defender-tamper-check'
$defenderStatus = Get-MpComputerStatus
Write-Output "vectis-provision: defender-tamper-protected=$($defenderStatus.IsTamperProtected)"
Write-Output 'vectis-provision: defender-policy'
try {
  $defenderPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender'
  New-Item -Path $defenderPolicy -Force | Out-Null
  Set-ItemProperty -Path $defenderPolicy -Name DisableAntiSpyware -Value 1 -Type DWord
  $realtimePolicy = Join-Path $defenderPolicy 'Real-Time Protection'
  New-Item -Path $realtimePolicy -Force | Out-Null
  foreach ($name in @('DisableRealtimeMonitoring', 'DisableBehaviorMonitoring', 'DisableIOAVProtection', 'DisableScriptScanning', 'DisableOnAccessProtection')) {
    Set-ItemProperty -Path $realtimePolicy -Name $name -Value 1 -Type DWord
  }
  $spynetPolicy = Join-Path $defenderPolicy 'Spynet'
  New-Item -Path $spynetPolicy -Force | Out-Null
  Set-ItemProperty -Path $spynetPolicy -Name SpynetReporting -Value 0 -Type DWord
  Set-ItemProperty -Path $spynetPolicy -Name SubmitSamplesConsent -Value 2 -Type DWord
} catch {
  Write-Warning "vectis-provision: defender-policy-blocked: $($_.Exception.Message)"
}
Write-Output 'vectis-provision: defender-preferences'
try {
  Set-MpPreference -DisableRealtimeMonitoring $true -DisableBehaviorMonitoring $true -DisableIOAVProtection $true -DisableScriptScanning $true -MAPSReporting 0 -SubmitSamplesConsent 2
} catch {
  Write-Warning "vectis-provision: defender-preferences-blocked: $($_.Exception.Message)"
}
Write-Output 'vectis-provision: defender-verify'
$defenderStatus = Get-MpComputerStatus
$defenderPreferences = Get-MpPreference
$defenderMode = 'disabled'
if ($defenderStatus.RealTimeProtectionEnabled -ne $false -or
    $defenderPreferences.DisableRealtimeMonitoring -ne $true -or
    $defenderPreferences.DisableBehaviorMonitoring -ne $true -or
    $defenderPreferences.DisableIOAVProtection -ne $true -or
    $defenderPreferences.DisableScriptScanning -ne $true -or
    $defenderPreferences.MAPSReporting -ne 0 -or
    $defenderPreferences.SubmitSamplesConsent -ne 2) {
  Write-Output 'vectis-provision: defender-exclusion-fallback'
  Add-MpPreference -ExclusionPath 'C:\'
  $defenderPreferences = Get-MpPreference
  if (@($defenderPreferences.ExclusionPath) -notcontains 'C:\') { throw 'Defender remains enabled and the C:\ exclusion was blocked.' }
  $defenderStatus = Get-MpComputerStatus
  $defenderMode = 'exclusion'
}
$defenderState = [pscustomobject]@{
  Mode = $defenderMode
  IsTamperProtected = $defenderStatus.IsTamperProtected
  RealTimeProtectionEnabled = $defenderStatus.RealTimeProtectionEnabled
  DisableRealtimeMonitoring = $defenderPreferences.DisableRealtimeMonitoring
  DisableBehaviorMonitoring = $defenderPreferences.DisableBehaviorMonitoring
  DisableIOAVProtection = $defenderPreferences.DisableIOAVProtection
  DisableScriptScanning = $defenderPreferences.DisableScriptScanning
  MAPSReporting = $defenderPreferences.MAPSReporting
  SubmitSamplesConsent = $defenderPreferences.SubmitSamplesConsent
  ExclusionPath = @($defenderPreferences.ExclusionPath)
}
Write-Output "vectis-provision: defender-mode=$defenderMode realtime=$($defenderStatus.RealTimeProtectionEnabled)"
`;

export function windowsDefenderBootScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$toolchainRoot = 'C:\ProgramData\Vectis'
$bootReceipt = Join-Path $toolchainRoot 'security-boot.json'
$bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
Start-Transcript -Path (Join-Path $toolchainRoot 'security-boot.log') -Force | Out-Null
try {
${defenderScript}
  Write-Output 'vectis-provision: security-boot-verify'
  $services = @{}
  foreach ($name in @('wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'WSearch', 'SysMain')) {
    $service = Get-Service -Name $name
    $services[$name] = [pscustomobject]@{ StartType = [string]$service.StartType; Status = [string]$service.Status }
    if ($name -notin @('UsoSvc', 'WaaSMedicSvc') -and ($service.StartType -ne 'Disabled' -or $service.Status -ne 'Stopped')) { throw "Service $name did not stay disabled after boot." }
  }
  $updatePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
  $noAutoUpdate = (Get-ItemProperty -Path $updatePolicy).NoAutoUpdate
  if ($noAutoUpdate -ne 1) { throw 'Windows Update policy did not stay disabled after boot.' }
  $hvciPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity'
  $hvciEnabled = $null
  if (Test-Path -LiteralPath $hvciPath) { $hvciEnabled = (Get-ItemProperty -Path $hvciPath).Enabled }
  $deviceGuard = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard
  $hvciRunning = @($deviceGuard.SecurityServicesRunning) -contains 2
  if (($null -ne $hvciEnabled -and $hvciEnabled -ne 0) -or $hvciRunning) { throw 'HVCI is still enabled after boot.' }
  $manifestPath = Join-Path $toolchainRoot 'toolchain.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $manifest | Add-Member -NotePropertyName Defender -NotePropertyValue $defenderState -Force
  $manifest | Add-Member -NotePropertyName Services -NotePropertyValue $services -Force
  $manifest | Add-Member -NotePropertyName NoAutoUpdate -NotePropertyValue $noAutoUpdate -Force
  $manifest | Add-Member -NotePropertyName HVCI -NotePropertyValue ([pscustomobject]@{ Enabled = $hvciEnabled; Running = $hvciRunning; RebootRequired = $false }) -Force
  $manifest | Add-Member -NotePropertyName BootVerification -NotePropertyValue $bootTime -Force
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  [pscustomobject]@{ Status = 'verified'; BootTime = $bootTime; Defender = $defenderState } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bootReceipt -Encoding utf8
  Write-Output "vectis-provision: defender-boot-verified mode=$defenderMode boot=$bootTime"
} catch {
  [pscustomobject]@{ Status = 'failed'; BootTime = $bootTime; Error = $_.Exception.Message } |
    ConvertTo-Json | Set-Content -LiteralPath $bootReceipt -Encoding utf8
  throw
} finally {
  Stop-Transcript | Out-Null
}
`;
}

export function windowsToolchainScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Output 'vectis-provision: toolchain-admin-check'
if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') { throw 'ARM64 Windows is required.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows toolchain provisioning requires an elevated administrator.' }
$toolchainRoot = 'C:\ProgramData\Vectis'
New-Item -ItemType Directory -Path $toolchainRoot -Force | Out-Null
function Get-VectisToolVersion([string]$Executable, [string[]]$Arguments) {
  if (!(Test-Path -LiteralPath $Executable)) { return '' }
  $output = & $Executable @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Tool verification failed: $Executable ($($output -join ' '))" }
  return ($output -join [Environment]::NewLine).Trim()
}
function Get-VectisRelease([string]$Url, [string]$Sha256, [string]$Destination) {
  Write-Output "vectis-provision: tool-download $Url"
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300
      break
    } catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  Write-Output 'vectis-provision: tool-checksum'
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant() -ne $Sha256) { throw "Tool checksum mismatch: $Url" }
}
${defenderScript}
Write-Output 'vectis-provision: windows-update-policy'
$updatePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item -Path $updatePolicy -Force | Out-Null
Set-ItemProperty -Path $updatePolicy -Name NoAutoUpdate -Value 1 -Type DWord
if ((Get-ItemProperty -Path $updatePolicy).NoAutoUpdate -ne 1) { throw 'Windows Update policy did not persist.' }
$serviceStates = @{}
foreach ($serviceName in @('wuauserv', 'UsoSvc', 'WaaSMedicSvc', 'WSearch', 'SysMain')) {
  Write-Output "vectis-provision: service-$serviceName"
  $serviceErrors = @()
  try {
    Set-Service -Name $serviceName -StartupType Disabled
  } catch {
    $serviceErrors += $_.Exception.Message
  }
  try {
    Stop-Service -Name $serviceName -Force
  } catch {
    $serviceErrors += $_.Exception.Message
  }
  $serviceError = $serviceErrors -join '; '
  $service = Get-Service -Name $serviceName
  $disabled = $service.StartType -eq 'Disabled' -and $service.Status -eq 'Stopped'
  $serviceStates[$serviceName] = [pscustomobject]@{ StartType = [string]$service.StartType; Status = [string]$service.Status; Error = $serviceError }
  if (!$disabled) {
    if ($serviceName -notin @('UsoSvc', 'WaaSMedicSvc')) { throw "Service $serviceName is not disabled and stopped: $serviceError" }
    Write-Warning "vectis-provision: service-$serviceName-protected start=$($service.StartType) status=$($service.Status): $serviceError"
  } else {
    Write-Output "vectis-provision: service-$serviceName-disabled"
  }
}
Write-Output 'vectis-provision: hvci'
$hvciPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity'
$hvciBefore = $null
if (Test-Path -LiteralPath $hvciPath) { $hvciBefore = (Get-ItemProperty -Path $hvciPath).Enabled }
$hvciEnabled = $hvciBefore
if ($null -ne $hvciBefore) {
  Set-ItemProperty -Path $hvciPath -Name Enabled -Value 0 -Type DWord
  if ((Get-ItemProperty -Path $hvciPath).Enabled -ne 0) { throw 'HVCI configuration did not persist.' }
  $hvciEnabled = 0
}
$deviceGuard = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard
$hvciRunning = @($deviceGuard.SecurityServicesRunning) -contains 2
$hvciState = [pscustomobject]@{ PreviousEnabled = $hvciBefore; Enabled = $hvciEnabled; Running = $hvciRunning; RebootRequired = ($hvciRunning -or ($null -ne $hvciBefore -and $hvciBefore -ne 0)) }
Write-Output "vectis-provision: hvci-configured enabled=$($hvciState.Enabled) reboot-required=$($hvciState.RebootRequired)"
$downloads = Join-Path $env:TEMP ('vectis-toolchain-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloads | Out-Null
try {
  Write-Output 'vectis-provision: git-install'
  $gitRoot = 'C:\Program Files\Git'
  $gitExe = Join-Path $gitRoot 'cmd\git.exe'
  $bashExe = Join-Path $gitRoot 'bin\bash.exe'
  $tarExe = Join-Path $gitRoot 'usr\bin\tar.exe'
  if ((Get-VectisToolVersion $gitExe @('--version')) -ne 'git version 2.55.0.windows.5' -or !(Test-Path -LiteralPath $bashExe) -or !(Test-Path -LiteralPath $tarExe)) {
    $installer = Join-Path $downloads 'git-arm64.exe'
    Get-VectisRelease '${windowsGit.url}' '${windowsGit.sha256}' $installer
    $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES /ALLUSERS /DIR="C:\Program Files\Git" /COMPONENTS="gitlfs" /o:PathOption=BashOnly' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Git installer failed: $($process.ExitCode)" }
  }
  Write-Output 'vectis-provision: git-verify'
  $gitVersion = Get-VectisToolVersion $gitExe @('--version')
  $tarVersion = Get-VectisToolVersion $tarExe @('--version')
  $bashVersion = Get-VectisToolVersion $bashExe @('--version')
  if ($gitVersion -ne 'git version 2.55.0.windows.5' -or $tarVersion -notmatch 'GNU tar' -or $bashVersion -notmatch 'GNU bash') { throw 'Full Git, GNU tar or Bash verification failed.' }
  Write-Output 'vectis-provision: zstd-install-x64-emulation'
  $zstdRoot = 'C:\Program Files\zstd'
  $zstdExe = Join-Path $zstdRoot 'zstd.exe'
  if ((Get-VectisToolVersion $zstdExe @('--version')) -notmatch 'v1\.5\.7\b') {
    $archive = Join-Path $downloads 'zstd.zip'
    Get-VectisRelease '${windowsZstd.url}' '${windowsZstd.sha256}' $archive
    $extracted = Join-Path $downloads 'zstd'
    Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
    foreach ($nested in @(Get-ChildItem -LiteralPath $extracted -Recurse -Filter '*.zip' -File)) {
      Expand-Archive -LiteralPath $nested.FullName -DestinationPath (Join-Path $extracted 'nested') -Force
    }
    $binaries = @(Get-ChildItem -LiteralPath $extracted -Recurse -Filter zstd.exe -File)
    if ($binaries.Count -ne 1) { throw 'Expected exactly one zstd.exe in the verified release.' }
    New-Item -ItemType Directory -Path $zstdRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $binaries[0].DirectoryName '*') -Destination $zstdRoot -Recurse -Force
  }
  Write-Output 'vectis-provision: zstd-verify'
  $zstdVersion = Get-VectisToolVersion $zstdExe @('--version')
  if ($zstdVersion -notmatch 'v1\.5\.7\b') { throw 'zstd x64 emulation verification failed.' }
  Write-Output 'vectis-provision: pwsh-install'
  $pwshRoot = 'C:\Program Files\PowerShell\7'
  $pwshExe = Join-Path $pwshRoot 'pwsh.exe'
  $pwshArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()')
  if ((Get-VectisToolVersion $pwshExe $pwshArguments) -ne '${windowsPowerShell.version}') {
    $installer = Join-Path $downloads 'pwsh-arm64.msi'
    Get-VectisRelease '${windowsPowerShell.url}' '${windowsPowerShell.sha256}' $installer
    $msiArguments = '/i "' + $installer + '" /qn /norestart ADD_PATH=1 USE_MU=0 ENABLE_MU=0 ENABLE_PSREMOTING=0 DISABLE_TELEMETRY=1'
    $process = Start-Process -FilePath msiexec.exe -ArgumentList $msiArguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw "PowerShell MSI failed: $($process.ExitCode)" }
    if ($process.ExitCode -eq 3010) { Write-Output 'vectis-provision: pwsh-reboot-required' }
  }
  Write-Output 'vectis-provision: pwsh-verify'
  $pwshVersion = Get-VectisToolVersion $pwshExe $pwshArguments
  if ($pwshVersion -ne '${windowsPowerShell.version}') { throw 'PowerShell 7 verification failed.' }
} finally {
  Remove-Item -LiteralPath $downloads -Recurse -Force
}
Write-Output 'vectis-provision: toolchain-path'
$toolPaths = @((Join-Path $gitRoot 'bin'), (Join-Path $gitRoot 'cmd'), $zstdRoot, $pwshRoot)
$minGitPaths = @('C:\Program Files\MinGit\cmd', 'C:\Program Files\MinGit\bin')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$remainingPath = @($machinePath -split ';' | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -notin ($toolPaths + $minGitPaths) })
[Environment]::SetEnvironmentVariable('Path', (($toolPaths + $remainingPath) -join ';'), 'Machine')
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($tool in @('git.exe', 'bash.exe', 'zstd.exe', 'pwsh.exe')) {
  $resolved = (Get-Command $tool -CommandType Application).Source
  if ($resolved -notin @($gitExe, $bashExe, $zstdExe, $pwshExe)) { throw "Unexpected tool on PATH: $tool at $resolved" }
}
Write-Output 'vectis-provision: toolchain-manifest'
$manifestPath = Join-Path $toolchainRoot 'toolchain.json'
$manifest = [pscustomobject]@{}
if (Test-Path -LiteralPath $manifestPath) { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
$system = Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber
$values = @{
  WindowsProductName = $system.WindowsProductName
  WindowsVersion = $system.WindowsVersion
  OsBuildNumber = $system.OsBuildNumber
  Git = $gitVersion
  GnuTar = ($tarVersion -split "\r?\n")[0]
  Zstd = $zstdVersion
  ZstdArchitecture = 'x64-emulated'
  PowerShell = $pwshVersion
  Defender = $defenderState
  Services = $serviceStates
  NoAutoUpdate = (Get-ItemProperty -Path $updatePolicy).NoAutoUpdate
  HVCI = $hvciState
  BootVerification = 'pending: inspect security-boot.json after the next boot'
}
foreach ($name in $values.Keys) { $manifest | Add-Member -NotePropertyName $name -NotePropertyValue $values[$name] -Force }
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output 'vectis-provision: defender-startup-task'
$bootScript = Join-Path $toolchainRoot 'verify-security.ps1'
[IO.File]::WriteAllText($bootScript, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(windowsDefenderBootScript()).toString("base64")}')), [Text.UTF8Encoding]::new($true))
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\Vectis\verify-security.ps1"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'Vectis-VerifySecurity' -Action $action -Trigger $trigger -Settings $settings -User SYSTEM -RunLevel Highest -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $toolchainRoot 'security-boot.json')) { Remove-Item -LiteralPath (Join-Path $toolchainRoot 'security-boot.json') -Force }
Write-Output 'vectis-provision: defender-boot-verification-pending'
`;
}
