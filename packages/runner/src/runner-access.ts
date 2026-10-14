import { Schema } from "effect";
import { RunnerAccess } from "../../protocol/src/repository-access.js";
import { VectisError, type Environment } from "../../protocol/src/index.js";

export const assignmentRejectedMarker = "VECTIS_RUNNER_ASSIGNMENT_REJECTED";
export const assignmentRejectedPath = "vectis-actions-runner/_vectis/assignment-rejected";

export function assignmentRejectedScript(os: Environment["os"]) {
  if (os === "windows")
    return `$marker = Join-Path $env:USERPROFILE '${assignmentRejectedPath}'
if (Test-Path -LiteralPath $marker -PathType Leaf) {
  Write-Output '${assignmentRejectedMarker}'
  Get-Content -LiteralPath $marker
}
`;
  return `marker="$HOME/${assignmentRejectedPath}"
if test -f "$marker"; then
  printf '${assignmentRejectedMarker}\\n'
  cat "$marker"
fi
`;
}

export function renderRunnerPolicy(input: unknown) {
  const access = Schema.decodeUnknownSync(RunnerAccess)(input);
  if (access.approval === "required" && !access.approvedRun)
    throw new VectisError("approval_required", "A required approval must identify a run attempt.");
  if (access.approval === "automatic" && access.approvedRun)
    throw new VectisError(
      "invalid_runner_policy",
      "An automatic runner cannot carry a manual approval.",
    );
  return `repositoryId=${access.repositoryId}
actors=${access.actors === "any" ? "any" : [...new Set(access.actors.ids)].join(",")}
approval=${access.approval}
runId=${access.approvedRun?.runId ?? ""}
runAttempt=${access.approvedRun?.runAttempt ?? ""}
`;
}

export function bashJobStartedHook() {
  return `#!/bin/bash
block_forever() {
  trap '' HUP INT TERM
  while :; do sleep 3600; done
}
refuse() {
  trap - ERR EXIT
  trap '' HUP INT TERM PIPE
  set +eu
  printf '::error::Vectis refused this job: %s\\n' "$1" || block_forever
  printf '${assignmentRejectedMarker}\\n' || block_forever
  printf '%s\\n' "$1" > "$HOME/${assignmentRejectedPath}.tmp" || block_forever
  mv -f "$HOME/${assignmentRejectedPath}.tmp" "$HOME/${assignmentRejectedPath}" || block_forever
  ancestor=$$
  worker=
  listener=
  for ((depth=0; depth<64; depth++)); do
    if [[ -r "/proc/$ancestor/stat" ]]; then
      IFS= read -r stat < "/proc/$ancestor/stat" || block_forever
      name="\${stat#*(}"
      name="\${name%%)*}"
      read -r state parent rest <<< "\${stat##*) }" || block_forever
    else
      parent=$(ps -o ppid= -p "$ancestor") || block_forever
      name=$(ps -o comm= -p "$ancestor") || block_forever
      name="\${name##*/}"
    fi
    parent="\${parent//[[:space:]]/}"
    [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 && "$parent" != "$ancestor" ]] || block_forever
    if [[ -z "$worker" && "$name" == Runner.Worker ]]; then
      worker=$ancestor
    elif [[ -n "$worker" && "$name" == Runner.Listener ]]; then
      listener=$ancestor
      break
    fi
    ancestor=$parent
  done
  [[ -n "$worker" && -n "$listener" ]] || block_forever
  kill -KILL "$worker" || block_forever
  kill -KILL "$listener" || block_forever
  block_forever
}
trap 'refuse "policy verification failed"' ERR EXIT
set -eu
policy_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$policy_dir/policy"
[[ "\${GITHUB_REPOSITORY_ID:-}" == "$repositoryId" ]] || refuse "repository id mismatch"
if [[ "$approval" == required ]]; then
  [[ -n "$runId" && -n "$runAttempt" && "\${GITHUB_RUN_ID:-}" == "$runId" && "\${GITHUB_RUN_ATTEMPT:-}" == "$runAttempt" ]] || refuse "run approval mismatch"
fi
if [[ "$actors" != any ]]; then
  actor="\${GITHUB_ACTOR_ID:-}"
  [[ "$actor" =~ ^[1-9][0-9]*$ ]] || refuse "actor id unavailable"
  [[ ",$actors," == *",$actor,"* ]] || refuse "actor not allowed"
  # The event sender describes the original event, not a later rerun's triggering actor.
  [[ "\${GITHUB_RUN_ATTEMPT:-}" == 1 ]] || refuse "triggering actor id unavailable for rerun"
  event="\${GITHUB_EVENT_PATH:-}"
  [[ -f "$event" && -n "\${GITHUB_TRIGGERING_ACTOR:-}" ]] || refuse "triggering actor id unavailable"
  if command -v jq >/dev/null 2>&1; then
    sender=$(jq -er --arg login "$GITHUB_TRIGGERING_ACTOR" '.sender | select(.login == $login) | .id | select(type == "number" and . > 0 and . == floor)' "$event") || refuse "triggering actor id unavailable"
  elif command -v python3 >/dev/null 2>&1; then
    sender=$(python3 - "$event" "$GITHUB_TRIGGERING_ACTOR" <<'VECTIS_PYTHON'
import json, sys
with open(sys.argv[1], encoding="utf-8") as event:
    sender = json.load(event)["sender"]
value = sender["id"]
if sender.get("login") != sys.argv[2] or type(value) is not int or value <= 0:
    sys.exit(1)
print(value)
VECTIS_PYTHON
) || refuse "triggering actor id unavailable"
  else
    refuse "JSON parser unavailable"
  fi
  [[ "$sender" =~ ^[1-9][0-9]*$ ]] || refuse "triggering actor id unavailable"
  [[ ",$actors," == *",$sender,"* ]] || refuse "triggering actor not allowed"
fi
trap - EXIT
`;
}

export function powershellJobStartedHook() {
  return `$ErrorActionPreference = 'Stop'
function Wait-Forever {
  while ($true) { Start-Sleep -Seconds 3600 }
}
function Refuse([string]$reason) {
  try {
    [Console]::Out.WriteLine("::error::Vectis refused this job: $reason")
    [Console]::Out.WriteLine('${assignmentRejectedMarker}')
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE '${assignmentRejectedPath}.tmp') -Value $reason
    Move-Item -LiteralPath (Join-Path $env:USERPROFILE '${assignmentRejectedPath}.tmp') -Destination (Join-Path $env:USERPROFILE '${assignmentRejectedPath}') -Force
    [Console]::Out.Flush()
    [Console]::Error.Flush()
    $ancestor = $PID
    $worker = $null
    $listener = $null
    for ($depth = 0; $depth -lt 64; $depth++) {
      $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ancestor"
      if (!$process -or $process.ParentProcessId -le 1 -or $process.ParentProcessId -eq $ancestor) { Wait-Forever }
      if (!$worker -and $process.Name -ceq 'Runner.Worker.exe') {
        $worker = $ancestor
      } elseif ($worker -and $process.Name -ceq 'Runner.Listener.exe') {
        $listener = $ancestor
        break
      }
      $ancestor = $process.ParentProcessId
    }
    if (!$worker -or !$listener) { Wait-Forever }
    Stop-Process -Id $worker -Force -ErrorAction Stop
    Stop-Process -Id $listener -Force -ErrorAction Stop
  } catch { Wait-Forever }
  Wait-Forever
}
try {
  $policy = ConvertFrom-StringData (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'policy') -Raw)
  if ($env:GITHUB_REPOSITORY_ID -cne $policy.repositoryId) { Refuse 'repository id mismatch' }
  if ($policy.approval -eq 'required') {
    if (!$policy.runId -or !$policy.runAttempt -or $env:GITHUB_RUN_ID -cne $policy.runId -or $env:GITHUB_RUN_ATTEMPT -cne $policy.runAttempt) { Refuse 'run approval mismatch' }
  }
  if ($policy.actors -ne 'any') {
    $allowed = $policy.actors.Split(',')
    if ($env:GITHUB_ACTOR_ID -cnotmatch '^[1-9][0-9]*$') { Refuse 'actor id unavailable' }
    if ($allowed -cnotcontains $env:GITHUB_ACTOR_ID) { Refuse 'actor not allowed' }
    if ($env:GITHUB_RUN_ATTEMPT -cne '1') { Refuse 'triggering actor id unavailable for rerun' }
    if (!$env:GITHUB_EVENT_PATH -or !$env:GITHUB_TRIGGERING_ACTOR) { Refuse 'triggering actor id unavailable' }
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    $sender = $event.sender
    if (!$sender -or $sender.login -cne $env:GITHUB_TRIGGERING_ACTOR -or ($sender.id -isnot [long] -and $sender.id -isnot [int]) -or $sender.id -le 0) { Refuse 'triggering actor id unavailable' }
    if ($allowed -cnotcontains [string]$sender.id) { Refuse 'triggering actor not allowed' }
  }
} catch { Refuse 'policy verification failed' }
`;
}
