$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') {
    throw 'This validation requires a native Windows ARM64 process'
}

function Get-SignedInstaller($Uri, $Path, $Publisher) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch $Publisher) {
        throw "Invalid installer signature: $Path"
    }
    Write-Output "Verified installer signer: $($signature.SignerCertificate.Subject)"
}

$pythonInstaller = Join-Path $env:RUNNER_TEMP 'python-arm64.exe'
$pythonDirectory = Join-Path $env:RUNNER_TEMP 'python-arm64'
Get-SignedInstaller 'https://www.python.org/ftp/python/3.14.8/python-3.14.8-arm64.exe' $pythonInstaller 'Python Software Foundation'
$pythonArguments = @('/quiet', 'InstallAllUsers=0', "TargetDir=`"$pythonDirectory`"", 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Include_tcltk=0', 'Shortcuts=0')
$installation = Start-Process -FilePath $pythonInstaller -ArgumentList $pythonArguments -Wait -PassThru
if ($installation.ExitCode -notin @(0, 3010)) {
    throw "Python installation failed: $($installation.ExitCode)"
}
$python = Join-Path $pythonDirectory 'python.exe'
& $python -c "import platform, sys; print(sys.version); assert platform.machine().lower() == 'arm64'"
if ($LASTEXITCODE -ne 0) { throw 'Python ARM64 verification failed' }
$pythonDirectory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
"PYTHON=$python" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

$toolsInstaller = Join-Path $env:RUNNER_TEMP 'vs_buildtools.exe'
$toolsDirectory = Join-Path $env:RUNNER_TEMP 'build-tools'
Get-SignedInstaller 'https://aka.ms/vs/stable/vs_buildtools.exe' $toolsInstaller 'Microsoft Corporation'
$toolsArguments = @('--quiet', '--wait', '--norestart', '--nocache', '--installPath', "`"$toolsDirectory`"", '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--add', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64', '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100')
$installation = Start-Process -FilePath $toolsInstaller -ArgumentList $toolsArguments -Wait -PassThru
if ($installation.ExitCode -notin @(0, 3010)) {
    throw "Build Tools installation failed: $($installation.ExitCode)"
}
if (-not (Test-Path (Join-Path $toolsDirectory 'Common7/Tools/VsDevCmd.bat'))) {
    throw 'Build Tools installation did not produce VsDevCmd.bat'
}
"VECTIS_BUILD_TOOLS=$toolsDirectory" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
