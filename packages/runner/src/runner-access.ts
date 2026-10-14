import { Schema } from "effect";
import { RunnerAccess } from "../../protocol/src/repository-access.js";
import { VectisError } from "../../protocol/src/index.js";

export const assignmentRejectedMarker = "VECTIS_RUNNER_ASSIGNMENT_REJECTED";

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
set -eu
policy_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
refuse() {
  printf '::error::Vectis refused this job: %s\\n' "$1"
  printf '${assignmentRejectedMarker}\\n'
  printf '${assignmentRejectedMarker}\\n' > "$policy_dir/rejected"
  exit 1
}
trap 'refuse "policy verification failed"' ERR
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
`;
}

export function powershellJobStartedHook() {
  return `$ErrorActionPreference = 'Stop'
function Refuse([string]$reason) {
  Write-Output "::error::Vectis refused this job: $reason"
  Write-Output '${assignmentRejectedMarker}'
  Set-Content -LiteralPath (Join-Path $PSScriptRoot 'rejected') -Value '${assignmentRejectedMarker}'
  exit 1
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
