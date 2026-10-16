---
name: vectis
description: Operate Vectis, which runs GitHub Actions jobs in disposable VMs on the user's Mac, through its CLI or MCP server. Use for preparing Ubuntu, macOS or Windows environments, connecting repositories, choosing runs-on labels, running and diagnosing runners and jobs, remote control of other Macs, and workflow migration.
---

# Vectis

Vectis runs each GitHub Actions job in a fresh VM on the user's Apple silicon Mac. A local background service owns the VMs; the desktop app, the `vectis` CLI and the `vectis-mcp` server are clients of that service. A hosted account at https://vectis.kerd.dev/connect links the Mac, GitHub and repositories.

Full documentation for agents: https://vectis.kerd.dev/llms.txt

## Find the tools

- Installed app: `vectis` and `vectis-mcp` are on PATH after the user chooses Diagnostics > Command line tools > Install. Otherwise run `/Applications/Vectis.app/Contents/Resources/bin/vectis`.
- Source checkout: `pnpm build`, then `pnpm vectis` and `pnpm mcp`.
- Check the build with `vectis --version`, `vectis capabilities --json` and `vectis doctor --json`. Only use commands that capability discovery lists. Capabilities of kind `query` have their own CLI commands and MCP tools; submit only kind `command` through `vectis_command` or `command --file`.

## Rules that are never negotiable

- Never approve a pairing, login or GitHub link on the user's behalf, and never share those links. Give the link and verification code to the user and wait.
- Never type, store or ask for a guest OS password. macOS and Windows setup steps that need a person at the VM console belong to the user.
- Never report accepted or running work as done. Report what the operation says, including `action_required` and its `nextStep`.
- Do not install, uninstall or update the login service, pause the machine, or enable automatic runners unless the user asked for it.
- Never remove a Mac from an account, unlink a GitHub account, delete an account or run `cloud disconnect` unless the user asked for that exact step.
- Approving pull request runs from forks is a GitHub maintainer decision. Never work around it.

## Operations

Every change is an operation: `accepted`, `running`, `action_required`, `succeeded`, `failed` or `cancelled`.

- Pass a stable `--key` (MCP: `key`) and reuse it only to retry the exact same command. A repeated key never repeats work.
- `--wait` waits up to `--timeout` (default 120000 ms). When time runs out, the CLI prints the operation as it is now and exits with 3. MCP `vectis_wait` returns it with `timedOut: true`; call it again to keep waiting.
- Read one operation with `vectis operation get <id> --json` or MCP `vectis_operation`. Cancel with `vectis operation cancel <id>`; cancelling a wait does not cancel the operation.
- Commands with `activity: "setting"` in capabilities always wait in the CLI, including pause/resume, repository enable-auto/disable-auto, environment register/configure/remove, instance stop/reconcile, operation cancel and activity cancel. A timeout returns a `wait_cancelled` error with exit code 3; the operation may still be running. MCP command submission is unchanged.
- An activity is what someone asked for; its operations are the steps that carried it out. `vectis activity list --json` (MCP `vectis_activities`, filters `--kind vectis|github`, `--status`, `--repository`, `--limit`) lists them newest first, and `vectis activity get <id> --json` (MCP `vectis_activity`) returns one with its operations. They also ride in `vectis status --json` as `activities`, and they never change operation IDs or request keys. Use `vectis activity cancel <activity-id>` or MCP `vectis_command` with `activity.cancel` to cancel its owned tasks or close a wait. Preparations with an owned setup must be resumed or discarded, and interrupted runners must be reconciled. Inspect the final status after requesting cancellation.
- Completed activity history expires after 30 days, or beyond the newest 300 completions once older than 24 hours. Recent, unfinished and actively owned work stays; unlinked terminal maintenance expires after 24 hours. A pruned request key returns `operation_expired` and must not be replayed as new work. An older service may omit `activities` (treat as empty) and `revision` (change state is unknown).
- The same command closes an `action_required` operation that nothing is working on any more, after you reported it to the user. An interrupted runner and an image preparation refuse it: they have their own recovery commands.
- Output is always JSON. Exit codes: 0 success, 1 failed or cancelled, 3 action required or still pending. Errors look like `{"error":{"code","message","nextStep"}}`; follow `nextStep`.
- Displayed logs, stored operation details and retained runner and preparation diagnostics redact recognized credentials.
- When something fails or hangs, read `vectis logs --lines 200 --json` or MCP `vectis_logs` before retrying.

## Service

- `vectis status --json` shows the machine, environments, VMs, recent operations, cloud connection and service version. MCP: `vectis_status`.
- Status includes a `revision` for detecting changes and cached `repositories` when paired. Repository and job updates change the revision; job data stays available through `job list`.
- `vectis service install|start|stop [--if-idle]|status|uninstall`. MCP: `vectis_service`. `--if-idle` refuses to interrupt VMs or operations.
- `vectis machine configure --max-runners N` sets the concurrent runner limit (1-16, default 5); status includes `runnerCapacity` with max, active and available slots.
- `vectis pause` stops new VMs; running work continues. `vectis resume` allows them again.
- `cloud.state` in `status` is `unconfigured`, `connecting`, `connected`, `unavailable` or `removed`. `removed` means the account deleted this Mac: report it, and only disconnect when the user asks.
- The default home is `~/.vectis` (`~/.vectis-dev` for development builds). Pass `--home` only to work with an isolated state directory.

## Cloud, GitHub and remote control

1. Pair this Mac: `vectis cloud pair --json` (MCP `vectis_cloud` with `action: "pair"`). The user opens the link, compares the code and approves. Then `vectis cloud finish`. `vectis cloud disconnect` clears the saved connection and credential; the account record itself is removed by its owner on the connect page.
2. Link GitHub and install the App: `vectis github connect --json` returns the page. The user links their GitHub account there and installs the Vectis GitHub App on the account or organization that owns the repositories.
3. `vectis github accounts --json` lists verified accounts for `repository connect`.

Remote control of another Mac: `vectis login`, user approval, `vectis login finish`, then `vectis machine list --json`. Add `--machine <id>` to commands, or start `vectis-mcp --machine <id>`; MCP `vectis_machines` lists machines when logged in. A remote session never falls back to the local machine. Service lifecycle and cloud pairing only work on the host itself.

## Environments

An environment is a prepared guest image. Its ID becomes the runner label.

- Ubuntu 24.04: `vectis environment prepare-linux <id> --image-directory <dir> --storage-path <dir> --wait --json`. Needs about 8 GiB free. Resume an interrupted preparation with `environment resume <setup-id>`. Images with a shared SSH host key need fresh preparation; current images provision a separate key for each instance.
- macOS 26: `environment install-macos <id> --image-directory <dir> --storage-path <dir>` downloads Apple's large restore image unless `--restore-path` points at a local one, and needs 40 to 60 GiB. It stops at `action_required`: the user completes Setup Assistant in `environment open-macos-setup`, then `connect-macos-guest`, `verify-macos-guest`, shuts the guest down and `finish-macos-setup`. `discard-macos` deletes an unregistered attempt only with the user's confirmation.
- Windows 11 (experimental): `environment install-windows` needs the user's own ISO, VirtIO drivers ISO, ARM64 UEFI firmware and license acceptance, plus QEMU with both Vectis TPM and network isolation patches, qemu-img and swtpm that the user installs. Guests default to IPv4 internet-only access and cannot initiate connections to host or private network services unless explicitly configured with open egress.
- Windows 11 (experimental): `environment install-windows` needs the user's own ISO, VirtIO drivers ISO, ARM64 UEFI firmware and license acceptance, plus QEMU with both Vectis TPM and network isolation patches, qemu-img and swtpm that the user installs. Guests have IPv4 internet access but cannot initiate connections to host or private network services.
- Windows 11 (experimental): `environment install-windows` needs the user's own ISO, VirtIO drivers ISO, ARM64 UEFI firmware and license acceptance, plus QEMU, qemu-img and swtpm that the user installs.
- Interrupted Windows setup preserves its disk and setup identity. Inspect the private `setup.ppm`, host `preparation.log` and `bootstrap-diagnostic.json` when available. The latter retains the guest bootstrap error; only its known stage is exposed in the operation message. Resume with `environment resume-windows <setup-id>` after confirmed VM exit. Resume regenerates setup media and retries a failed bootstrap once over SSH; unreachable SSH requires human recovery. Never share setup media, credentials or detailed diagnostics.
- `environment configure <id> --cpu --memory-mib --storage-path` changes defaults for future VMs; a VM may use at most 75% of host memory. `vectis storage --json` separates image and VM disk usage.
- Network egress: `environment configure <id> --egress internet_only|open` applies to future instances. Windows defaults to enforced `internet_only`; explicit `open` disables the filter and permits host and local network access. Linux and macOS NAT is `open` / `not_enforced` and rejects `internet_only` with `egress_unsupported`. `status`, `environment list` and MCP `vectis_status` report effective `network.egress` and `network.enforcement`; existing instances keep their original networking.
- Linux x86_64 tools: `environment configure <id> --x64 rosetta` enables x86_64 binaries and `docker run --platform linux/amd64`; `--x64 off` disables it for future instances. Requires Rosetta installed on the Mac and a newly prepared Linux image. Missing guest support reports `rosetta_guest_unprepared`: prepare the environment again. The runner stays ARM64, X64 labels do not match, and setup actions still default to ARM64. Changing x64 changes the environment revision; preparing leases using the old revision need cleanup and a fresh attempt.
- Downloading or preparing images uses many gigabytes. Only start it when the user asked.

## Repositories and labels

- Call `vectis repository readiness <owner/name> [--environment <id>] --json` (MCP `vectis_readiness`) before connecting, or use `vectis repository readiness --binding <id> --json` when jobs stay queued. Resolve blocked checks using their `code`, `nextStep` and symbolic `target`. Unknown checks have not been verified; attention checks such as a missing binding or disabled automatic runners do not block readiness. This read does not connect repositories or enable runners.
- `vectis repository connect <name> --account <id> --environment <id> [--owner <org>] --wait --json` connects a repository to this Mac. The linked GitHub account needs admin permission on organization repositories. Public repositories require the GitHub setting that makes all external contributors wait for approval.
- `vectis repository connect <name> --account <id> --environment <id> [--owner <org>] --wait --json` connects a repository to this Mac. The linked GitHub account needs admin permission on organization repositories. Public repositories require the GitHub setting that makes all external contributors wait for approval. Private repositories must disable fork workflows or require approval for them.
- `vectis repository list --json` (MCP `vectis_repositories`) shows each connection with its `runsOn` label.
- A workflow reaches an environment with `runs-on: vectis-<environment-id>`. It may also list `self-hosted`, the OS label (`Linux`, `macOS` or `Windows`) and `ARM64`, and nothing else. Any other label keeps the job away from Vectis.
- `repository enable-auto <binding-id>` starts runners automatically for matching queued jobs; `disable-auto` stops that. `repository disconnect <binding-id>` stops future runners and lets running jobs finish.

- `vectis repository access <binding-id> --actors any|<id,id,...> --approval automatic|required` sets a per-binding capacity policy. IDs are positive numeric GitHub user IDs (up to 100, deduplicated), never logins: find one with `gh api users/<login> --jq .id`. Absent policy preserves `any` and `automatic`; enabling automatic runners is a separate setting.
- Restrictive policies use the run API's actor and triggering actor IDs. Both must be allowed. Job lists expose `access: approval_required|actor_not_allowed|actor_unknown` for waiting capacity. Unknown actors never auto-start. Reset with `--actors any --approval automatic`.
- For required approval, starting `runner run <binding-id> --job-id <id>` manually approves this host's capacity for the job's run ID and attempt. It never overrides the actor allowlist or GitHub's maintainer approval of an external pull request. A restrictive policy requires a specific job ID.
- A public job-started hook inside every Linux, macOS and Windows guest checks the assigned repository ID and policy, because JIT runners can receive a different matching job. Required approval pins the run ID and attempt. A rejected assignment emits an error annotation and stops the runner before any further workflow step runs. GitHub may keep the job in progress until it times out after the runner stops. The host destroys the VM and returns `runner_assignment_rejected` with the policy reason after cleanup; inspect GitHub for the actual job result.
- On rejection, the hook writes `vectis-actions-runner/_vectis/assignment-rejected` inside the guest home, then forcibly stops only its own Runner.Worker and Runner.Listener ancestors. Any failure blocks the hook instead of returning control to the Worker. The host checks that file every 10 seconds over a separate guest connection and stops the VM through normal cleanup. This relies on the public job-started hook and was verified with synthetic process trees, not a real runner.
- Actor-restricted reruns fail closed: the original event sender does not attest the rerun's triggering actor ID. Missing event sender or JSON parser also refuses the assignment. Ubuntu includes `jq` and `python3`; macOS must provide one. Windows uses `ConvertFrom-Json`. Listening runners retain their granted policy; changes affect subsequent admission and registration.

## Runners and jobs

- `vectis runner run <binding-id> --key <key> [--job-id <id>] --json` starts one disposable runner. Its success means the VM ran and was cleaned up, not that the job passed. Read job results with `vectis job list <binding-id> --json` or MCP `vectis_jobs`.
- Automatic runner requests are checked after two minutes and expire before claim if the machine is offline, or after ten minutes even if it is online. The queued job becomes available to another eligible machine on the next demand pass, within the existing three-attempt limit.
- Every runner drains after 5 idle minutes when its requested job no longer needs queued capacity. Manual runners without a job ID use the same idle window. Vectis confirms not busy before stopping the VM and releasing the lease; the operation reports `cancelled` with `runner_idle`.
- A locally listening runner reported offline or missing for 2 consecutive minutes stops with retryable `failed` code `runner_offline`. Continuous GitHub status errors for 15 minutes trigger the same recovery. Unconfirmed cleanup stays `action_required` until release is confirmed.
- Prepare failures with confirmed cleanup end as retryable `failed` with `runner_registration_failed`. A lost response is reconciled and fenced before retrying; unresolved cloud state remains `runner_registration_uncertain`. Approval-required cases retain their manual next steps.
- A runner activity's `subject.requestedJob` identifies the job that requested capacity; `subject.actualJob` identifies the job observed on its registered runner. Both are optional and can differ. Never infer the actual job from the requested job. Use their `name`, `workflowName` and `htmlUrl` only when present. The activity status still reports the runner lifecycle, including cleanup, independently of the GitHub job result.
- Actual job observation survives runner completion and service restarts. It watches up to 20 of the newest eligible leases from activities created within the last 48 hours, until each actual job completes. Missing observations remain unknown; stored observations stay in activity history.
- Read a GitHub job log with `vectis job logs <job-id> --binding <binding-id>`; `--follow` starts polling every 2 seconds, doubles the interval after empty chunks up to 30 seconds, resets to 2 seconds when text arrives, and stops when complete. `--json` prints one response per chunk. MCP `vectis_job_logs` takes `{bindingId, jobId, after?}`; pass `next` back as `after` (an absolute, nonnegative integer byte offset) to continue. Responses include `text`, `next`, `status`, `complete` and `truncated`. Logs are fetched on demand, without stored log archives, and preserve GitHub masking. Remote inspection responses expire after 60 seconds. Reads page through the last 4 MiB in UTF-8 chunks of at most 32 KiB; `truncated` means unread earlier bytes were skipped. Bounded Range requests download one chunk at a time when supported; fallback downloads are capped at 64 MiB. A running job may return empty text until GitHub publishes logs; only a completed job at EOF reports `complete: true`.
- `job scan <binding-id>` finds queued or running jobs Vectis missed; `job refresh <binding-id> <job-id>` rereads one job from GitHub.
- `run rerun-failed <binding-id> <run-id> --wait` reruns failed jobs of a completed run; `run cancel <binding-id> <run-id> --wait` requests cancellation of an active run. MCP uses `run.rerun-failed` and `run.cancel` through `vectis_command`.
- `workflow dispatch <binding-id> <workflow-file-or-id> --ref <branch-or-tag> [--input key=value ...] --wait` dispatches a workflow with up to 25 string inputs and complete command JSON of at most 65,535 bytes. MCP uses `workflow.dispatch`. Report the run ID only when returned; 204 means accepted, run ID unknown. Dispatch acceptance is not job completion.
- Run control requires GitHub App `actions: write`. For `github_app_permission_required`, ask the user to approve the updated App permissions on GitHub (Settings -> Applications), then retry. Rerun and dispatch require the public-repository fork approval policy; cancel does not.
- GitHub-accepted rerun and cancel requests finish as `succeeded` with `result.state: "accepted"`. Vectis rereads with backoff for up to 5 seconds for rerun or 20 seconds for cancel. `result.rerun` and `result.cancellation` are `"observed"` only after a newer attempt or stopped run is seen; otherwise they are `"requested"`, including when rereads fail. For requested cancellation, report "GitHub accepted the cancellation; the run is still stopping." Request success does not prove job completion.
- Run control retains a cloud receipt keyed by machine and operation key before any POST. Remote `remote:<id>` keys use the same receipt. A replay reads its stored outcome and never submits twice while the receipt is retained. The daily sweep expires receipts 30 days after their last update; do not replay keys after that window because duplicate protection has expired. Only ambiguous POST responses (network errors, 5xx or missing status) leave rerun or cancel `action_required` with `run_command_unconfirmed`: check GitHub before retrying with a new key, never blindly retry. Stopping the Vectis wait does not undo a submitted GitHub request.
- A failed runner whose guest connection was lost or whose runner process exited keeps `diagnostics` (runner output, SSH error, host network and guest state) in its operation `result`; read it with `vectis operation get <id> --json` before retrying.
- After restart, interrupted runners carry `runner_recovery_pending`. Startup and periodic recovery verify VM exit, reconcile the cloud lease and release the runner automatically once the instance is stopped or absent. Recovery also covers `runner_cleanup_required`, `runner_registration_uncertain` and legacy interrupted results without a code. Retries while connected back off from 1 minute, doubling to 30 minutes, for up to 24 hours; the schedule survives restarts. `runner_busy` means GitHub still holds the runner on a job, usually until it releases the job within 15 minutes. Unconfirmed VM exit or cloud release stays `action_required`. After 24 hours, the result includes a manual next step: `runner reconcile <operation-id>`, with `instance reconcile <id>` first if VM exit remains unconfirmed. Do not start new runners to hide uncertain cleanup.
- Refused assignments retain `cause: { code: "runner_assignment_rejected", message }` while cleanup waits. Successful manual or automatic reconciliation ends them as `failed` with `runner_assignment_rejected` and the original refusal message. Offline failures retain `failed` with `runner_offline`. Other interrupted runners end as `cancelled` with `runner_interrupted`; requests interrupted before startup began end as `failed` with the same code. Check GitHub separately for the job result.
- Runner reconciliation can close a request with no cloud lease only after confirming VM cleanup and recording the request as released in the cloud. An unavailable cloud remains unresolved; missing local lease metadata alone never proves cleanup.
- Failed file cleanup after an owned VM exits retains an exit receipt for instance reconciliation. A leftover directory alone does not prove the VM is running or stopped.

A job that stays queued usually has one of these causes. Check them in order:

1. The machine is paused (`status`), offline (`cloud.state`), or at its concurrent VM limit (`vectis machine configure --max-runners`, default 5, bounded by host CPU and 75% of memory), or busy with a preparation.
2. Automatic runners are off for the repository, so nobody starts a runner.
3. The workflow's `runs-on` labels do not match the connection's `runsOn` label.
4. The environment is not ready, or it was removed.
5. The job comes from a fork and waits for a maintainer's approval on GitHub.
6. The binding access policy requires manual capacity approval, rejects an actor, or has unknown actor IDs (`job list` exposes `access`).
7. The GitHub App is not installed on the repository's owner.

An automatic runner request a Mac never claims expires as `machine_offline` (offline, after 2 minutes) or `claim_timeout` (online, after 10 minutes), and the job is requested again so another connected Mac can take it.

## Workflow migration

- `vectis migration preview <workflow-file> --map <from>=<vectis-label>` rewrites `runs-on` locally without writing files.
- `vectis migration analyze <binding-id> --wait --json` prepares a preview for a connected repository; review every change and finding with the user. `migration publish <preview-id>` opens a pull request after a successful runner on the same environment, and never merges.
- Migration changes only selected label scalars, preserving quoting and all surrounding source formatting. Unsafe scalar forms require manual review. Optional per-file `jobs` summaries report changed jobs, reasons for retained selections and static `needs` edges.
- Migration only moves ARM64-compatible jobs. It leaves x64 labels, reusable workflows, dynamic matrices and privileged triggers alone.
