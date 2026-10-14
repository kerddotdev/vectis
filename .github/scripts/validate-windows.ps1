$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') { throw 'Windows must run natively on ARM64' }
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture | Format-List
$licenses = @(Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f'" | Where-Object { $_.Name -like 'Windows*' })
if ($licenses.Count -eq 0) { throw 'Windows licensing status could not be read' }
$licenses | Select-Object Name, Description, LicenseStatus | Format-Table -AutoSize
Write-Output 'This manual technical trial reports activation status and does not activate Windows.'
& node -e "if (process.arch !== 'arm64' || process.version !== 'v24.21.0') process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node ARM64 verification failed' }
if ((& pnpm --version) -ne '10.24.0') { throw 'Unexpected pnpm version' }
& $env:PYTHON -c "import platform; assert platform.machine().lower() == 'arm64'"
if ($LASTEXITCODE -ne 0) { throw 'Python ARM64 verification failed' }

$directory = Join-Path $env:RUNNER_TEMP 'native-validation'
New-Item -ItemType Directory -Path $directory | Out-Null
$source = Join-Path $directory 'main.cpp'
$executable = Join-Path $directory 'validation.exe'
@'
#include <windows.h>
#include <iostream>

int main() {
    SYSTEM_INFO system{};
    GetNativeSystemInfo(&system);
    if (system.wProcessorArchitecture != PROCESSOR_ARCHITECTURE_ARM64) return 1;
    std::cout << "Windows SDK and native ARM64 C++ execution verified\n";
    return 0;
}
'@ | Set-Content -Path $source -Encoding ascii
$developerCommand = Join-Path $env:VECTIS_BUILD_TOOLS 'Common7/Tools/VsDevCmd.bat'
$batch = Join-Path $directory 'build.cmd'
@"
@echo off
call "$developerCommand" -no_logo -arch=arm64 -host_arch=arm64
if errorlevel 1 exit /b 1
cd /d "$directory"
cl.exe /nologo /W4 /EHsc /MT /std:c++17 "$source" /Fe:"$executable"
exit /b %errorlevel%
"@ | Set-Content -Path $batch -Encoding ascii
& $env:ComSpec /d /c $batch
if ($LASTEXITCODE -ne 0) { throw 'ARM64 C++ compilation failed' }
$bytes = [IO.File]::ReadAllBytes($executable)
$header = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $header + 4) -ne 0xaa64) {
    throw 'Compiled executable is not ARM64'
}
& $executable
if ($LASTEXITCODE -ne 0) { throw 'Native ARM64 C++ execution failed' }
