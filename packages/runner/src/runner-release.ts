import type { RunnerAccess } from "../../protocol/src/repository-access.js";
import {
  renderRunnerPolicy,
  bashJobStartedHook,
  powershellJobStartedHook,
} from "./runner-access.js";
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

export function runnerStartScript(os: Environment["os"], jitConfig: string, access: RunnerAccess) {
  if (!/^[A-Za-z0-9+/=]{1,60000}$/.test(jitConfig))
    throw new VectisError(
      "invalid_runner_configuration",
      "The JIT runner configuration is invalid.",
    );
  const policy = renderRunnerPolicy(access);
  if (os === "windows")
    return `$ErrorActionPreference = 'Stop'
$gate = Join-Path $env:USERPROFILE 'vectis-runner-access'
New-Item -ItemType Directory -Path $gate -Force | Out-Null
@'
${policy}'@ | Set-Content -LiteralPath (Join-Path $gate 'policy') -Encoding utf8
@'
${powershellJobStartedHook()}'@ | Set-Content -LiteralPath (Join-Path $gate 'job-started.ps1') -Encoding utf8
$rejected = Join-Path $gate 'rejected'
Remove-Item -LiteralPath $rejected -ErrorAction SilentlyContinue
$env:ACTIONS_RUNNER_HOOK_JOB_STARTED = Join-Path $gate 'job-started.ps1'
Set-Location (Join-Path $env:USERPROFILE 'vectis-actions-runner')
& .\\bin\\Runner.Listener.exe run --jitconfig '${jitConfig}'
$runnerExit = $LASTEXITCODE
if (Test-Path -LiteralPath $rejected) { Get-Content -LiteralPath $rejected; exit 1 }
exit $runnerExit
`;
  return `set -eu
umask 077
gate="$HOME/vectis-runner-access"
mkdir -p "$gate"
cat > "$gate/policy" <<'VECTIS_POLICY'
${policy}VECTIS_POLICY
cat > "$gate/job-started.sh" <<'VECTIS_HOOK'
${bashJobStartedHook()}VECTIS_HOOK
chmod 700 "$gate/job-started.sh"
rm -f "$gate/rejected"
export ACTIONS_RUNNER_HOOK_JOB_STARTED="$gate/job-started.sh"
cd "$HOME/vectis-actions-runner"
runner_exit=0
./run.sh --jitconfig '${jitConfig}' || runner_exit=$?
if test -f "$gate/rejected"; then cat "$gate/rejected"; exit 1; fi
exit "$runner_exit"
`;
}
