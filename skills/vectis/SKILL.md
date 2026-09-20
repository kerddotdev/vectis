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
- When something fails or hangs, read `vectis logs --lines 200 --json` or MCP `vectis_logs` before retrying.

## Service

- `vectis status --json` shows the machine, environments, VMs, recent operations, cloud connection and service version. MCP: `vectis_status`.
- Status includes a `revision` for detecting changes and cached `repositories` when paired. Repository and job updates change the revision; job data stays available through `job list`.
- `vectis service install|start|stop [--if-idle]|status|uninstall`. MCP: `vectis_service`. `--if-idle` refuses to interrupt VMs or operations.
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

- Ubuntu 24.04: `vectis environment prepare-linux <id> --image-directory <dir> --storage-path <dir> --wait --json`. Needs about 8 GiB free. Resume an interrupted preparation with `environment resume <setup-id>`.
- macOS 26: `environment install-macos <id> --image-directory <dir> --storage-path <dir>` downloads Apple's large restore image unless `--restore-path` points at a local one, and needs 40 to 60 GiB. It stops at `action_required`: the user completes Setup Assistant in `environment open-macos-setup`, then `connect-macos-guest`, `verify-macos-guest`, shuts the guest down and `finish-macos-setup`. `discard-macos` deletes an unregistered attempt only with the user's confirmation.
- Windows 11 (experimental): `environment install-windows` needs the user's own ISO, VirtIO drivers ISO, ARM64 UEFI firmware and license acceptance, plus QEMU, qemu-img and swtpm that the user installs.
- `environment configure <id> --cpu --memory-mib --storage-path` changes defaults for future VMs; a VM may use at most 75% of host memory. `vectis storage --json` separates image and VM disk usage.
- Downloading or preparing images uses many gigabytes. Only start it when the user asked.

## Repositories and labels

- `vectis repository connect <name> --account <id> --environment <id> [--owner <org>] --wait --json` connects a repository to this Mac. The linked GitHub account needs admin permission on organization repositories. Public repositories require the GitHub setting that makes all external contributors wait for approval.
- `vectis repository list --json` (MCP `vectis_repositories`) shows each connection with its `runsOn` label.
- A workflow reaches an environment with `runs-on: vectis-<environment-id>`. It may also list `self-hosted`, the OS label (`Linux`, `macOS` or `Windows`) and `ARM64`, and nothing else. Any other label keeps the job away from Vectis.
- `repository enable-auto <binding-id>` starts runners automatically for matching queued jobs; `disable-auto` stops that. `repository disconnect <binding-id>` stops future runners and lets running jobs finish.

## Runners and jobs

- `vectis runner run <binding-id> --key <key> [--job-id <id>] --json` starts one disposable runner. Its success means the VM ran and was cleaned up, not that the job passed. Read job results with `vectis job list <binding-id> --json` or MCP `vectis_jobs`.
- `job scan <binding-id>` finds queued or running jobs Vectis missed; `job refresh <binding-id> <job-id>` rereads one job from GitHub.
- An interrupted runner or VM needs `runner reconcile <operation-id>` or `instance reconcile <id>` after the VM is confirmed stopped. Do not start new runners to hide an uncertain cleanup.

A job that stays queued usually has one of these causes. Check them in order:

1. The machine is paused (`status`), offline (`cloud.state`), or busy with another VM or a preparation.
2. Automatic runners are off for the repository, so nobody starts a runner.
3. The workflow's `runs-on` labels do not match the connection's `runsOn` label.
4. The environment is not ready, or it was removed.
5. The job comes from a fork and waits for a maintainer's approval on GitHub.
6. The GitHub App is not installed on the repository's owner.

## Workflow migration

- `vectis migration preview <workflow-file> --map <from>=<vectis-label>` rewrites `runs-on` locally without writing files.
- `vectis migration analyze <binding-id> --wait --json` prepares a preview for a connected repository; review every change and finding with the user. `migration publish <preview-id>` opens a pull request after a successful runner on the same environment, and never merges.
- Migration only moves ARM64-compatible jobs. It leaves x64 labels, reusable workflows, dynamic matrices and privileged triggers alone.
