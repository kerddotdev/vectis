import type { Environment } from "../../protocol/src/index.js";
import { VectisError } from "../../protocol/src/index.js";

export const runnerVersion = "2.337.0";
const distributions = {
  linux: {
    archive: "actions-runner-linux-arm64-2.337.0.tar.gz",
    sha256: "9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393",
  },
  macos: {
    archive: "actions-runner-osx-arm64-2.337.0.tar.gz",
    sha256: "5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2",
  },
  windows: {
    archive: "actions-runner-win-arm64-2.337.0.zip",
    sha256: "7ee1a72a0e0ad384ac7871ffc2356063a116e20d1db3ea41000eb49272cf0030",
  },
} as const;
export function runnerDistribution(os: Environment["os"]) {
  const distribution = distributions[os];
  return {
    ...distribution,
    version: runnerVersion,
    url: `https://github.com/actions/runner/releases/download/v${runnerVersion}/${distribution.archive}`,
  };
}

export function runnerInstallScript(os: Environment["os"]) {
  const { url, sha256 } = runnerDistribution(os);
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
$target = Join-Path $env:USERPROFILE 'vectis-actions-runner'
if (Test-Path $target) { throw 'Runner directory already exists. Use a fresh setup image.' }
New-Item -ItemType Directory -Path $target | Out-Null
$archive = Join-Path $target 'runner.zip'
Invoke-WebRequest -Uri '${url}' -OutFile $archive
if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne '${sha256}') { throw 'Runner checksum mismatch.' }
Expand-Archive -Path $archive -DestinationPath $target
Remove-Item $archive
`;
  return `set -eu
umask 077
target="$HOME/vectis-actions-runner"
if test -e "$target"; then printf 'Runner directory already exists. Use a fresh setup image.\\n' >&2; exit 1; fi
mkdir "$target"
cd "$target"
curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 -o runner.tar.gz '${url}'
printf '${sha256}  runner.tar.gz\\n' | ${os === "macos" ? "shasum -a 256" : "sha256sum"} -c -
tar xzf runner.tar.gz
rm runner.tar.gz
`;
}

export function runnerStartScript(os: Environment["os"], jitConfig: string) {
  if (!/^[A-Za-z0-9+/=]{1,60000}$/.test(jitConfig))
    throw new VectisError(
      "invalid_runner_configuration",
      "The JIT runner configuration is invalid.",
    );
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $env:USERPROFILE 'vectis-actions-runner')
& .\\bin\\Runner.Listener.exe run --jitconfig '${jitConfig}'
exit $LASTEXITCODE
`;
  return `set -eu
cd "$HOME/vectis-actions-runner"
exec ./run.sh --jitconfig '${jitConfig}'
`;
}
