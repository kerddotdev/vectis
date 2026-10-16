import type { Environment } from "../../protocol/src/index.js";
import { VectisError } from "../../protocol/src/index.js";
import {
  runnerDistribution,
  runnerVersion,
  preinstalledRunnerDirectory,
} from "./runner-release.js";

export function runnerPreinstallScript(os: Environment["os"], user = "vectis") {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(user))
    throw new VectisError("invalid_guest_user", "Provisioning requires a valid guest SSH user.");
  const { url, sha256 } = runnerDistribution(os);
  const directory = preinstalledRunnerDirectory(os);
  if (os === "windows")
    return `$runnerTarget = '${directory}'
$runnerMarker = Join-Path $runnerTarget '.vectis-installed'
if (!(Test-Path -LiteralPath $runnerMarker) -or !(Test-Path -LiteralPath (Join-Path $runnerTarget 'bin\\Runner.Listener.exe'))) {
  New-Item -ItemType Directory -Path $runnerTarget -Force | Out-Null
  $runnerArchive = Join-Path $runnerTarget 'runner.zip'
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $runnerArchive -TimeoutSec 300
      break
    } catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $runnerArchive).Hash.ToLowerInvariant() -ne '${sha256}') { throw 'Runner checksum mismatch.' }
  Expand-Archive -LiteralPath $runnerArchive -DestinationPath $runnerTarget -Force
  Remove-Item -LiteralPath $runnerArchive -Force
  '${runnerVersion}' | Set-Content -LiteralPath $runnerMarker -Encoding ascii
}
`;
  return `target="${directory}"
if ! test -f "$target/.vectis-installed" || ! test -x "$target/bin/Runner.Listener"; then
  ${os === "linux" ? `sudo -n install -d -m 0755 -o '${user}' "$target"` : 'mkdir -p "$target"'}
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 -o "$target/runner.tar.gz" '${url}'
  (cd "$target"; printf '${sha256}  runner.tar.gz\\n' | ${os === "macos" ? "shasum -a 256" : "sha256sum"} -c -)
  tar xzf "$target/runner.tar.gz" -C "$target"
  rm "$target/runner.tar.gz"
  ${os === "linux" ? `sudo -n "$target/bin/installdependencies.sh"\n  sudo -n chown -R '${user}' "$target"` : ""}
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
      : 'set -eu\numask 077\nmkdir -p "$HOME/.vectis-provision"\n: > "$HOME/.vectis-provision/setup.b64"',
  ];
  for (let offset = 0; offset < encoded.length; offset += 16384) {
    const chunk = encoded.slice(offset, offset + 16384);
    scripts.push(
      windows
        ? `$ErrorActionPreference = 'Stop'\n[IO.File]::AppendAllText((Join-Path $env:USERPROFILE '.vectis-provision\\setup.b64'), '${chunk}')`
        : `set -eu\nprintf '%s' '${chunk}' >> "$HOME/.vectis-provision/setup.b64"`,
    );
  }
  return scripts;
}

export function provisionScript(
  os: Environment["os"],
  options: { runner: boolean; setup: boolean; user: string },
) {
  const install = options.runner ? runnerPreinstallScript(os, options.user) : "";
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${install}${
      options.setup
        ? `$setupRoot = Join-Path $env:USERPROFILE '.vectis-provision'
$setup = Join-Path $setupRoot 'setup.ps1'
$setupBytes = [Convert]::FromBase64String([IO.File]::ReadAllText((Join-Path $setupRoot 'setup.b64')))
[IO.File]::WriteAllText($setup, [Text.Encoding]::UTF8.GetString($setupBytes), [Text.UTF8Encoding]::new($true))
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $setup
if ($LASTEXITCODE -ne 0) { throw 'Guest setup script failed.' }
Remove-Item -LiteralPath $setupRoot -Recurse -Force
`
        : ""
    }`;
  return `set -euo pipefail
${install}${
    options.setup
      ? `base64 ${os === "macos" ? "-D" : "--decode"} < "$HOME/.vectis-provision/setup.b64" > "$HOME/.vectis-provision/setup.sh"
bash "$HOME/.vectis-provision/setup.sh"
rm -rf "$HOME/.vectis-provision"
`
      : ""
  }`;
}

export function provisionShutdownScript(os: Environment["os"]) {
  if (os === "windows")
    return "$ErrorActionPreference = 'Stop'\n& shutdown.exe /s /t 0\nif ($LASTEXITCODE -ne 0) { throw 'Guest shutdown failed.' }\n";
  if (os === "macos") return "set -eu\nsudo -n /sbin/shutdown -h now\n";
  return `set -euo pipefail
sudo -n bash -s <<'VECTIS_IDENTITY'
rm -f /etc/ssh/ssh_host_* /etc/vectis/instance-id /var/lib/dbus/machine-id
printf 'uninitialized\\n' > /etc/machine-id
sync
poweroff
VECTIS_IDENTITY
`;
}
