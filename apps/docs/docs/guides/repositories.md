---
title: Repositories and labels
description: Connect repositories to a Mac, choose the runs-on label, and meet the rules for organizations and public repositories.
---

A connection ties one GitHub repository to one environment on one Mac. A repository can have several connections, for example Ubuntu on one Mac and macOS on another.

## Before you connect

- The Mac is [connected to your account](/docs/get-started/quickstart#2-connect-this-mac-to-your-account).
- Your GitHub account is linked, and the Vectis GitHub App is installed on the repository's owner with access to the repository.
- The environment exists on that Mac. App and CLI connections require it to be ready; web connections can be created before setup finishes.

## Connect

**App:** **Repositories > Connect a repository**, then pick the GitHub account, an optional organization, the repository and the environment.

**Web:** **Repositories > Connect a repository** at [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect), where you also pick the Mac.

**CLI:**

```sh
vectis github accounts --json
vectis repository readiness <owner>/<repository> --environment <environment-id> --json
vectis repository connect <repository> --account <account-id> --environment <environment-id> [--owner <organization>] --wait
vectis repository list --json
```

Readiness returns ordered checks with a status, an optional error code, a next step and a symbolic fix target. `ready` means no check is blocked or unknown. A missing connection or disabled automatic runners needs attention but does not block connecting. Readiness never connects a repository, changes GitHub policy or enables runners.

`repository list` shows each connection's ID (the binding ID used by other commands) and its `runsOn` label. Connecting the same repository and environment again reuses the connection.

## Capacity mode

Connections default to `demand`, which starts capacity for individually admitted queued jobs. The preview `scale_set` mode lets this Mac long-poll one GitHub runner scale set session and create runners from GitHub's assigned-job level. Automatic runners must be enabled in either mode.

```sh
vectis repository capacity-mode <binding-id> scale-set
vectis repository enable-auto <binding-id>
vectis repository list --json
vectis status --json
```

`repository list` includes `capacityMode`; listener state and error codes appear in `status.scaleSets`. Use the reported label or scale set name, and check the workflow against the preview integration before relying on it. See [scale set capacity](/docs/guides/runners#scale-set-capacity-preview) for lifecycle and verification limits.

Scale set preview requires actors `any` and approval `automatic`. Keep restrictive policies in demand mode; switching to scale sets refuses unsupported policies with `scale_set_policy_unsupported`. GitHub's external pull request approval remains a maintainer decision. Pausing, disabling automatic runners, disconnecting or changing mode stops new scale set intake and attempts to close its session without interrupting running jobs.

```sh
vectis repository disable-auto <binding-id>
vectis repository capacity-mode <binding-id> demand
```

## Who can use this Mac

Each connection can limit the numeric GitHub user IDs that may use its runner capacity, and require a manual start. Existing connections allow any actor and use automatic approval unless a policy is set. Automatic runner admission must still be enabled separately.

```sh
gh api users/<login> --jq .id
vectis repository access <binding-id> --actors <id,id,...> --approval required
vectis job list <binding-id> --json
vectis runner run <binding-id> --job-id <job-id> --key <stable-key> --wait
```

Use `--actors any` to allow all actors and `--approval automatic` to remove the manual approval requirement. Actor lists accept at most 100 positive integer user IDs and remove duplicates. Both the original run actor and the triggering actor must be allowed. Starting a specific job manually approves this Mac's capacity for that run ID and attempt; it cannot override the actor list or approve an external pull request on GitHub. Unknown actor IDs leave the job waiting. Job lists expose `access` as `approval_required`, `actor_not_allowed`, or `actor_unknown` when admission is blocked.

Vectis checks before starting a VM and again through GitHub's public job-started hook inside Linux, macOS and Windows guests. This second check matters because GitHub can assign a different matching queued job to an ephemeral runner. Every assignment must match the repository ID. Required approvals also match the approved run ID and attempt. A rejected assignment emits an error annotation and stops the runner before any further workflow step runs. The job shows as failed on GitHub with that annotation. The host destroys the VM and fails the operation with `runner_assignment_rejected` and the policy reason.

On rejection, the hook writes a marker file and forcibly terminates only its own Runner.Worker and Runner.Listener ancestors. If writing the marker or identifying or stopping those ancestors fails, the hook blocks instead of returning control to the Worker. The host checks the marker every 10 seconds over a separate guest connection and stops the VM through normal cleanup. This relies on GitHub's public job-started hook and was verified with synthetic process trees, not a real runner.

Actor-restricted assignments fail closed when the event does not identify the triggering actor. In particular, reruns are refused because their original event sender cannot attest the new triggering actor's numeric ID. Bash guests need `jq` or `python3` for this check; Ubuntu images include both, while macOS setup must provide one. Windows uses PowerShell's JSON parser. Policy changes apply to new admission and registration; a listening runner retains the policy granted when it registered.

## Choose the runs-on label

Each environment has one Vectis label: `vectis-<environment-id>`. The app, the web page and `repository list` show it next to every connection.

```yaml
runs-on: vectis-ubuntu
```

A job reaches Vectis when its `runs-on` labels include the Vectis label and nothing Vectis does not offer. Besides the Vectis label, a job may list only these, which every Vectis runner also carries:

- `self-hosted`
- the guest's OS: `Linux`, `macOS` or `Windows`
- `ARM64`

```yaml
runs-on: [self-hosted, Linux, ARM64, vectis-ubuntu] # also works
runs-on: [self-hosted, linux, x64, vectis-ubuntu] # never runs on Vectis: x64
runs-on: ubuntu-latest # GitHub-hosted, not Vectis
```

Guests are ARM64. Jobs that need x86-64 binaries or containers do not work unchanged; [workflow migration](/docs/guides/migrations) only moves jobs that can run on ARM64.

## Organization repositories

Select your own linked GitHub account and give the organization separately (`--owner <organization>`, or the owner field in the app and on the web). Your GitHub account needs **admin** permission on the repository. Organization membership alone is not enough. Vectis checks this again whenever it registers a runner, reads jobs or opens a migration pull request.

## Public repositories

Anyone can open a pull request against a public repository, and its workflows would run on your Mac. Vectis therefore requires this GitHub setting before it connects a public repository or registers a runner for it:

**Settings > Actions > General > Approval for running fork pull request workflows from contributors: Require approval for all external contributors.**

A maintainer then approves each outside contributor's run on GitHub after reviewing the change. Vectis never changes this setting and never approves a run. Forks do not inherit your runners. Review outside code the way you would for any self-hosted runner: approval is the protection, not a guarantee against hostile code.

Private repositories must disable fork pull request workflows or enable **Require approval for fork pull request workflows** in the same settings page. Vectis checks this when connecting a repository and before registering each runner.

## Disconnect

**App:** the connection's menu, **Disconnect repository**. **Web:** **Disable connection**. **CLI:** `vectis repository disconnect <binding-id>`.

Disconnecting stops new runners for that connection. Running jobs finish normally. The GitHub App installation and your workflows stay as they are; jobs that still ask for the label wait until another connection provides it.

## Repository cache volumes

Cache volumes are opt-in. A connection can retain tool downloads and package caches between jobs on the same machine and environment:

```sh
vectis repository cache enable <binding-id> --size-gib 20
vectis repository cache disable <binding-id>
vectis repository cache clear <binding-id>
```

The default size cap is 20 GiB; `--size-gib` accepts whole GiB from 1 to 1024. Omitting it preserves the binding's existing size, or uses 20 for a new setting. Disable affects future jobs and preserves the existing cache. To resize, disable, wait for running jobs to finish, clear, then enable with the new size. Clearing refuses active or unreconciled cache instances. Disconnecting a repository deletes its saved generations and prevents running forks from writing back. A disconnect made in the cloud is applied when the host receives the authoritative binding list, including after reconnecting.

The host stores a sparse raw `cache.img` under `<environment-storage>/cache/<environment-id>/<installation-id>-<repository-id>/`. Without a custom storage path, environment storage is `<home>/instances`. Numeric installation and repository IDs establish ownership; repository names do not. Environments are isolated to keep guest filesystems separate. Each VM receives an APFS clone of the current generation as its own writable **block device** in the instance directory. The host never mounts the guest filesystem or shares a host folder with it. APFS clone support is required; there is no full-copy fallback. The cap applies to each disk's logical capacity, not the total host storage: concurrent forks, one retained previous generation and changed copy-on-write blocks can use additional space.

First use formats the cache inside the guest. Linux identifies the `VECTISCACHE` virtio device, checks its size and that it has no mounted filesystems, formats blank disks as ext4, then mounts at `/vectis-cache`. macOS excludes the root APFS physical store, requires a single other physical disk with the exact configured size, and initializes only a blank disk as APFS at `/Volumes/VECTISCACHE`. Unknown layouts and unexpected existing filesystems fail closed. Windows identifies the separate NVMe disk by serial `VECTISCACHE`, excludes boot and system disks, checks its size and initializes only RAW disks as NTFS. Windows assigns an available drive letter. Guest setup requires passwordless `sudo` on Linux/macOS or an elevated Windows runner account.

Before the runner listener starts, it exports these paths to jobs:

| Variable               | Directory inside the cache |
| ---------------------- | -------------------------- |
| `RUNNER_TOOL_CACHE`    | `toolcache`                |
| `npm_config_cache`     | `npm`                      |
| `npm_config_store_dir` | `pnpm`                     |
| `YARN_CACHE_FOLDER`    | `yarn`                     |
| `PIP_CACHE_DIR`        | `pip`                      |
| `GOMODCACHE`           | `gomod`                    |
| `GOCACHE`              | `go-build`                 |

Workflows and setup actions can override these variables. Cargo is deliberately unchanged: `CARGO_HOME` also contains executables and configuration. The runner itself and the checkout remain on the disposable boot disk.

### Write-back authority

The cloud grants `cacheWrite: true` only for a known job whose workflow run is a `push`, `schedule`, or `workflow_dispatch`, targets the repository's current default branch, and has `head_repository.id` equal to the binding's repository ID. It reads `/actions/runs/{run_id}` and the verified repository's default branch when preparing the lease. Unreadable or missing metadata denies write-back. Pull requests, `pull_request_target`, forks, other branches and runners started without a specific job ID always discard their forks. Scale set runners have no known workflow run at prepare time and always receive `cacheWrite: false`, including when cache volumes are enabled. They can read the saved generation but discard their changes. The job-started hook fences writable grants to their run ID and attempt so another queued job cannot reuse that grant.

A writable fork becomes the new generation only after the listener finishes normally, the guest successfully unmounts or offlines the cache, and the VM process exits. Failed runner lifecycles, cancellation, uncertain cleanup and guest connection loss leave the current generation intact. A failed workflow step can still populate the cache if the runner lifecycle and unmount complete normally. Promotions are serialized by the host and use atomic rename. Concurrent writers use **last-completed-promotion wins**; changes from parallel forks are not merged. One previous generation is retained, and a missing current image can recover from it. Crashed instances never replay a promotion: reconcile them through the normal instance and runner commands.

A cache is shared job input, not a secret store. Any admitted job, including an approved pull request, can read the generation attached to its own fork. Keep credentials and sensitive artifacts out of cache directories. Cache write restrictions do not approve fork workflows or bypass GitHub's maintainer approval policy. These paths and scripts have synthetic test coverage; real Linux, macOS and Windows guest verification is still required before claiming native cache reuse.

Repository cache jobs use a cold VM start so the private cache disk is attached before boot. They do not claim generic warm pool VMs; idle pool VMs yield when the job needs their capacity. Jobs without a cache volume can still use the warm pool.
