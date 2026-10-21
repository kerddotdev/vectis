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
  & $gitExe config --system http.sslBackend schannel
  if ($LASTEXITCODE -ne 0) { throw 'Git Windows certificate store configuration failed.' }
  $gitSslBackend = Get-VectisToolVersion $gitExe @('config', '--system', '--get', 'http.sslBackend')
  if ($gitSslBackend -ne 'schannel') { throw 'Git must use the Windows certificate store (schannel).' }
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
$toolPaths = @((Join-Path $gitRoot 'bin'), (Join-Path $gitRoot 'cmd'), $zstdRoot, $pwshRoot, (Join-Path $gitRoot 'usr\bin'))
$minGitPaths = @('C:\Program Files\MinGit\cmd', 'C:\Program Files\MinGit\bin')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$remainingPath = @($machinePath -split ';' | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -notin ($toolPaths + $minGitPaths) })
[Environment]::SetEnvironmentVariable('Path', (($toolPaths + $remainingPath) -join ';'), 'Machine')
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$expectedTools = @{
  'git.exe' = @($gitExe, (Join-Path $gitRoot 'bin\git.exe'))
  'bash.exe' = @($bashExe)
  'tar.exe' = @($tarExe)
  'zstd.exe' = @($zstdExe)
  'pwsh.exe' = @($pwshExe)
}
foreach ($tool in $expectedTools.Keys) {
  $resolved = @(Get-Command $tool -CommandType Application -All)[0].Source
  if ($resolved -notin $expectedTools[$tool]) { throw "Unexpected tool on PATH: $tool at $resolved" }
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
  Defender = [pscustomobject]@{ Mode = 'policy-exclusion'; PolicyExclusionPath = @('C:\'); AppliesAt = 'next-boot' }
  Services = $serviceStates
  NoAutoUpdate = (Get-ItemProperty -Path $updatePolicy).NoAutoUpdate
  HVCI = $hvciState
}
foreach ($name in $values.Keys) { $manifest | Add-Member -NotePropertyName $name -NotePropertyValue $values[$name] -Force }
$manifest.PSObject.Properties.Remove('BootVerification')
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output 'vectis-provision: remove-security-startup-task'
if (Get-ScheduledTask -TaskName 'Vectis-VerifySecurity' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'Vectis-VerifySecurity' -Confirm:$false
}
foreach ($file in @('verify-security.ps1', 'security-boot.json', 'security-boot.log')) {
  $path = Join-Path $toolchainRoot $file
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
`;
}
