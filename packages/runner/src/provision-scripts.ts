import { windowsToolchainScript } from "./windows-toolchain.js";
import type { Environment } from "../../protocol/src/index.js";
import { VectisError } from "../../protocol/src/index.js";
import {
  runnerDistribution,
  runnerVersion,
  preinstalledRunnerDirectory,
} from "./runner-release.js";

export function runnerPreinstallScript(
  os: Environment["os"],
  options: { dependencies?: boolean } = {},
) {
  const { url, sha256 } = runnerDistribution(os);
  const directory = preinstalledRunnerDirectory(os);
  if (os === "windows")
    return `$runnerTarget = '${directory}'
$runnerMarker = Join-Path $runnerTarget '.vectis-installed'
if (!(Test-Path -LiteralPath $runnerMarker) -or !(Test-Path -LiteralPath (Join-Path $runnerTarget 'bin\\Runner.Listener.exe'))) {
  Write-Output 'vectis-provision: directory'
  New-Item -ItemType Directory -Path $runnerTarget -Force | Out-Null
  $runnerArchive = Join-Path $runnerTarget 'runner.zip'
  Write-Output 'vectis-provision: download'
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $runnerArchive -TimeoutSec 300
      break
    } catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  Write-Output 'vectis-provision: checksum'
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $runnerArchive).Hash.ToLowerInvariant() -ne '${sha256}') { throw 'Runner checksum mismatch.' }
  Write-Output 'vectis-provision: extract'
  Expand-Archive -LiteralPath $runnerArchive -DestinationPath $runnerTarget -Force
  Write-Output 'vectis-provision: remove-archive'
  Remove-Item -LiteralPath $runnerArchive -Force
  Write-Output 'vectis-provision: installed'
  '${runnerVersion}' | Set-Content -LiteralPath $runnerMarker -Encoding ascii
}
`;
  return `set -euo pipefail
target="${directory}"
if ! test -f "$target/.vectis-installed" || ! test -x "$target/bin/Runner.Listener"; then
  echo 'vectis-provision: directory'
  mkdir -p "$target"
  echo 'vectis-provision: download'
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 -o "$target/runner.tar.gz" '${url}'
  echo 'vectis-provision: checksum'
  (cd "$target"; printf '${sha256}  runner.tar.gz\\n' | ${os === "macos" ? "shasum -a 256" : "sha256sum"} -c -)
  echo 'vectis-provision: extract'
  tar xzf "$target/runner.tar.gz" -C "$target"
  echo 'vectis-provision: remove-archive'
  rm "$target/runner.tar.gz"
  ${
    os === "linux" && options.dependencies !== false
      ? `runner_dependencies_present() {
    local library linked libraries ldconfig_command
    command -v ldd >/dev/null || { echo 'Runner dependency check requires ldd.' >&2; return 1; }
    for library in libcoreclr.so libSystem.Security.Cryptography.Native.OpenSsl.so libSystem.IO.Compression.Native.so; do
      linked=$(ldd "$target/bin/$library" 2>&1) || { printf '%s\\n' "$linked" >&2; return 1; }
      if printf '%s\\n' "$linked" | grep -F 'not found' >&2; then return 1; fi
    done
    ldconfig_command=$(command -v ldconfig || printf '/sbin/ldconfig')
    libraries=$("$ldconfig_command" -p) || return 1
    for library in libicuuc libssl libcrypto libkrb5 libz liblttng-ust; do
      if ! printf '%s\\n' "$libraries" | grep -E "^[[:space:]]*$library\\\\.so(\\\\.|[[:space:]])" >/dev/null; then
        printf 'Missing runner system library: %s\\n' "$library" >&2
        return 1
      fi
    done
  }
  echo 'vectis-provision: dependencies-check'
  if runner_dependencies_present; then
    echo 'vectis-provision: dependencies-present'
  else
    echo 'vectis-provision: dependencies-install'
    if ! sudo -n true; then
      echo 'Runner dependencies are missing and passwordless sudo is unavailable. Install the missing libraries in the guest before provisioning.' >&2
      exit 1
    fi
    sudo -n "$target/bin/installdependencies.sh"
    echo 'vectis-provision: dependencies-verify'
    if ! runner_dependencies_present; then
      echo 'Runner dependencies are still missing after installation.' >&2
      exit 1
    fi
  fi`
      : ""
  }
  echo 'vectis-provision: installed'
  printf '${runnerVersion}\\n' > "$target/.vectis-installed"
fi
`;
}

export function setupUploadScripts(os: Environment["os"], script: string) {
  if (Buffer.byteLength(script, "utf8") > 65536)
    throw new VectisError("guest_script_too_large", "Setup scripts cannot exceed 64 KiB UTF-8.");
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const windows = os === "windows";
  const scripts = [
    windows
      ? "$ErrorActionPreference = 'Stop'\n$directory = Join-Path $env:USERPROFILE '.vectis-provision'\nNew-Item -ItemType Directory -Path $directory -Force | Out-Null\n[IO.File]::WriteAllText((Join-Path $directory 'setup.b64'), '')"
      : 'set -eu\necho \'vectis-provision: setup-upload\'\numask 077\nmkdir -p "$HOME/.vectis-provision"\n: > "$HOME/.vectis-provision/setup.b64"',
  ];
  for (let offset = 0; offset < encoded.length; offset += 16384) {
    const chunk = encoded.slice(offset, offset + 16384);
    scripts.push(
      windows
        ? `$ErrorActionPreference = 'Stop'\n[IO.File]::AppendAllText((Join-Path $env:USERPROFILE '.vectis-provision\\setup.b64'), '${chunk}')`
        : `set -eu\necho 'vectis-provision: setup-upload'\nprintf '%s' '${chunk}' >> "$HOME/.vectis-provision/setup.b64"`,
    );
  }
  return scripts;
}

export function provisionScript(
  os: Environment["os"],
  options: { runner: boolean; setup: boolean },
) {
  const install = options.runner ? runnerPreinstallScript(os) : "";
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${windowsToolchainScript()}${install}${
      options.setup
        ? `Write-Output 'vectis-provision: setup-decode'
$setupRoot = Join-Path $env:USERPROFILE '.vectis-provision'
$setup = Join-Path $setupRoot 'setup.ps1'
$setupBytes = [Convert]::FromBase64String([IO.File]::ReadAllText((Join-Path $setupRoot 'setup.b64')))
[IO.File]::WriteAllText($setup, [Text.Encoding]::UTF8.GetString($setupBytes), [Text.UTF8Encoding]::new($true))
Write-Output 'vectis-provision: setup'
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $setup
if ($LASTEXITCODE -ne 0) { throw 'Guest setup script failed.' }
Write-Output 'vectis-provision: setup-cleanup'
Remove-Item -LiteralPath $setupRoot -Recurse -Force
`
        : ""
    }`;
  return `set -euo pipefail
${install}${
    options.setup
      ? `echo 'vectis-provision: setup-decode'
base64 ${os === "macos" ? "-D" : "--decode"} < "$HOME/.vectis-provision/setup.b64" > "$HOME/.vectis-provision/setup.sh"
echo 'vectis-provision: setup'
bash "$HOME/.vectis-provision/setup.sh"
echo 'vectis-provision: setup-cleanup'
rm -rf "$HOME/.vectis-provision"
`
      : ""
  }`;
}

export function provisionMacosShutdownScript() {
  return `set -eu
echo 'vectis-provision: loginwindow-shutdown'
osascript -e 'tell application "loginwindow" to «event aevtshut»'
`;
}

export function provisionShutdownScript(os: Environment["os"]) {
  if (os === "windows")
    return "$ErrorActionPreference = 'Stop'\nWrite-Output 'vectis-provision: shutdown'\n& shutdown.exe /s /t 0\nif ($LASTEXITCODE -ne 0) { throw 'Guest shutdown failed.' }\n";
  if (os === "macos")
    return "set -eu\necho 'vectis-provision: shutdown'\nsudo -n /sbin/shutdown -h now\n";
  return "set -eu\necho 'vectis-provision: shutdown'\nsudo -n poweroff\n";
}

export function provisionLinuxIdentityResetScript() {
  return `set -euo pipefail
sudo -n bash -s <<'VECTIS_IDENTITY'
set -euo pipefail
echo 'vectis-provision: clear-identity'
rm -f /etc/ssh/ssh_host_* /etc/vectis/instance-id /var/lib/dbus/machine-id
printf 'uninitialized\\n' > /etc/machine-id
echo 'vectis-provision: sync'
sync
VECTIS_IDENTITY
`;
}
