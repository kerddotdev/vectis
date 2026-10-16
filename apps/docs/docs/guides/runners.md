---
title: Runners and jobs
description: Automatic and manual runners, reading job results, cancelling and recovering.
---

Every job runs on its own runner in its own VM. Vectis boots a copy of the environment, registers a GitHub runner that accepts exactly one job, runs it, then deletes the VM and the registration.

## Automatic runners

Turn on **Automatic** for a connection in **Repositories**, or:

```sh
vectis repository enable-auto <binding-id>
vectis repository disable-auto <binding-id>
```

With automatic runners on, the Mac looks for queued jobs that match the connection's label every heartbeat, about every 30 seconds, and scans GitHub for missed jobs at most every five minutes. It starts runners when it is connected and not paused, one per queued job, and a new job also starts one right away instead of waiting for the next heartbeat.

A Mac runs up to five runners at once by default; change it in **Settings** or with `vectis machine configure --max-runners <N>` (1 to 16). The Mac also never starts more than its CPU and memory allow: all running and starting VMs together get at most every CPU core and 75 percent of the memory, and at most two macOS VMs run at a time. Capacity is calculated separately for each ready environment, including resources reserved for runners that have not booted yet. With a 6 CPU environment on a 14 core Mac, at most two such VMs fit, whatever the runner limit says. `vectis status --json` includes each environment's available slots; the overall available count is their maximum, not their sum. Interrupted VMs reserve their CPU, memory and macOS slot until verified stopped. An action-required runner whose VM is verified stopped releases its local slot while cleanup remains unresolved. Give an environment fewer CPUs or less memory with `vectis environment configure` to run more.

Before booting a VM, and again before registering the runner, Vectis checks with GitHub that the job is still queued. GitHub may hand the runner a different job with the same labels. If the original job is still queued after a runner succeeded, Vectis can request another runner without consuming the failure budget. Automatic admission stops after three failures or ten total attempts per job. Failures include failed operations, requests that expire before claim, and action-required operations. Failed and expired requests wait 60 seconds before retrying; action-required operations wait ten minutes. A deleted previous operation can retry after ten minutes without inventing a failure. A person's cancellation stays final unless GitHub queues the job again after an approval or concurrency wait.

Automatic runners are off until you turn them on, per connection. These CLI commands wait for the setting to be applied without needing `--wait`, and return a nonzero exit code if it fails or needs attention.

## Manual runners

Start one runner yourself with **Start runner** on the connection, or:

```sh
vectis runner run <binding-id> --key <any-unique-key> --json
vectis runner run <binding-id> --job-id <github-job-id> --json   # only if that job is still queued
```

A manual runner without a job ID waits for work and drains after 5 idle minutes. The listener has a six-hour maximum lifetime, including job execution.

An automatic runner request that the Mac does not pick up expires so another Mac connected to the same repository can take the job: after 2 minutes with result code `machine_offline` if the Mac went offline, or after 10 minutes with `claim_timeout` if it stayed online. The job is requested again on the next heartbeat.

Every runner is drained after 5 minutes of inactivity if its requested job no longer needs queued capacity. Manual runners without a requested job drain after the same idle window. Vectis confirms the runner is not busy, stops the VM and releases the lease, reporting `cancelled` with result code `runner_idle`. Busy runners and runners whose jobs still need queued capacity keep listening.

A locally listening runner that GitHub reports offline or missing for 2 consecutive minutes is stopped with retryable failure code `runner_offline`. Continuous status read failures for 15 minutes trigger the same recovery. Cleanup must be confirmed before the operation ends; unconfirmed cleanup stays `action_required`.

## Read phase timings

Inspect a runner with `vectis operation get <operation-id> --json`, or use `vectis activity get <activity-id> --json` to include its child operations. The runner operation's `result.phases` retains phase timestamps as `stage` changes. CLI output is always JSON; `--json` makes it compact. MCP `vectis_operation`, `vectis_activity` and `vectis_status` return the same data, locally and through remote inspection.

Each phase has a `name`, an ISO UTC `startedAt`, and an optional `endedAt`. Subtract the timestamps to get its duration: `00:00:00.000Z` to `00:00:12.300Z` is 12.3 seconds. A closed phase measures an attempt, including a failed or cancelled one; use the operation status to determine its outcome. A missing end means the phase is still running or was interrupted before its end was recorded. Older operations may have no phases.

| Phase                      | Measured interval                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued_locally`           | Local operation acceptance to lifecycle task start, including local admission checks. This excludes waiting in GitHub or the cloud.                            |
| `job_check`                | One check that the requested job still needs capacity, before startup, before registration, or while idle.                                                     |
| `vm_start`                 | The `environment.start` child, including validation, cloning and spawning, until it confirms the VM is running.                                                |
| `vm_start_and_guest_ready` | Rosetta startup, including guest address discovery, pinned SSH readiness, clock and architecture checks, and Rosetta verification inside `environment.start`.  |
| `guest_ready`              | Guest readiness and the pinned SSH connection. After `vm_start_and_guest_ready`, this is a readiness recheck; the initial wait is already included in startup. |
| `runner_install`           | Downloading, verifying and extracting the runner.                                                                                                              |
| `registration`             | Preparing the GitHub JIT registration and validating its grant.                                                                                                |
| `waiting_for_job`          | Registration end to the guest's job-started hook timestamp, or listener exit if no job is observed.                                                            |
| `job`                      | The guest's job-started hook timestamp until the guest listener exits.                                                                                         |
| `cleanup`                  | Stopping the VM and releasing the runner, including registration reconciliation attempted by this task. Later recovery retries are not included.               |

The protocol also accepts `runner_preinstalled` for a future installation-skip marker; current runners record `runner_install`. After policy verification, the guest job-started hook atomically writes epoch milliseconds to `vectis-actions-runner/_vectis/job-started`. The existing policy gate poll reads it every 10 seconds and once after listener exit, without adding guest connections. A late marker corrects an earlier busy observation, including for short jobs that finish between polls. Guest readiness verifies clock skew is within 60 seconds; the hook timestamp is clamped between registration end and observation time, capped at listener exit when already known.

If the marker is missing, invalid or unreadable, job timing falls back to GitHub's busy-status poll, normally every 30 seconds. That fallback uses the host's observation time and can miss short jobs. Bash uses GNU `date` milliseconds or Perl `Time::HiRes` on macOS; a timestamp failure leaves the policy decision unchanged and uses the busy fallback. Windows uses PowerShell 5.1-compatible .NET timestamp and file APIs. The measured start is the hook boundary, and the end is listener exit, including runner teardown. Clock skew still affects guest timestamps; never infer job success or an exact GitHub queue duration from these timings.

History is bounded to 16 entries. When idle checks repeat, the oldest completed `job_check` entries are removed to preserve startup and cleanup. Idle checks overlap `waiting_for_job` or `job`; do not sum overlapping phases as total elapsed time.

## Read job results

A runner operation that succeeded means the VM ran and was cleaned up. It does not say whether the job passed. The job's result comes from GitHub:

- **App:** open a connection in **Repositories** to see its recent jobs.
- **CLI:** `vectis job list <binding-id> --json` returns the latest 100 jobs with their GitHub status and conclusion.

Job states arrive through GitHub webhooks. Vectis checks for failed deliveries every two minutes and requests one automatic redelivery per webhook, usually recovering missed updates within a few minutes without a connected Mac. If one still seems missing or stale:

```sh
vectis job scan <binding-id> --wait             # find queued and running jobs Vectis missed
vectis job refresh <binding-id> <job-id> --wait # reread one job from GitHub
```

## Rerun, cancel and dispatch

Control a connected repository's GitHub Actions runs from the CLI or MCP `vectis_command`:

```sh
vectis run rerun-failed <binding-id> <run-id> --wait
vectis run cancel <binding-id> <run-id> --wait
vectis workflow dispatch <binding-id> ci.yml --ref main --input target=staging --wait
```

`workflow` accepts a file name or numeric ID, `ref` is a branch or tag, and `--input key=value` can be repeated for up to 25 string inputs. Vectis limits the complete command JSON to 65,535 bytes, including keys and metadata. The workflow must enable `workflow_dispatch`. Like other intents, these commands return an operation immediately unless `--wait` is supplied. The same typed commands work through local and remote clients; the desktop recognizes their operations but has no run control buttons yet.

The GitHub App needs **Actions: write**. Existing installations must approve the updated permissions in GitHub **Settings -> Applications**. A missing approval returns `github_app_permission_required` with instructions. After correcting a rejected request, submit a new operation key; replaying the old key returns its stored rejection. Public repositories require approval for every external contributor before rerun or dispatch; cancellation does not require that policy.

Rerun requires a completed run with failed jobs. After GitHub accepts a rerun or cancellation, Vectis rereads the run with backoff for up to 5 seconds for rerun or 20 seconds for cancellation. Both requests finish as `succeeded` with `result.state: "accepted"`:

- `result.cancellation: "observed"` means Vectis observed the run stopped (`completed` or `cancelled`). `"requested"` means GitHub accepted cancellation, but Vectis has not observed it stop. The message is "GitHub accepted the cancellation; the run is still stopping."
- `result.rerun: "observed"` means Vectis observed a newer attempt. `"requested"` means GitHub accepted the rerun, but the newer attempt is not yet visible.

A failed reread does not undo GitHub's acceptance. Request success does not mean the jobs passed. Dispatch reports the run ID when GitHub returns it. An empty 204 response means accepted with an unknown run ID.

GitHub has no idempotency keys for these requests. Vectis saves a cloud receipt before submission and never repeats a POST for the same machine and operation key while that receipt is retained, including remote replay. The daily retention sweep removes receipts older than 30 days since their last update. Do not replay old keys after that window: their duplicate protection has expired.

Only an ambiguous POST response (such as a network error, 5xx response or missing status) leaves rerun or cancellation `action_required` with `run_command_unconfirmed`. Check the run on GitHub before submitting a new key; never blindly retry. Cancelling the Vectis operation stops waiting and can leave the GitHub outcome unconfirmed.

## Read a job's log

Read a failed job directly through Vectis, using its GitHub job ID and repository binding:

```sh
vectis job logs <job-id> --binding <binding-id>
vectis job logs <job-id> --binding <binding-id> --follow
```

The first command prints the retained log. `--follow` starts polling every 2 seconds, doubles the interval after empty chunks up to 30 seconds, and resets it to 2 seconds when text arrives. It stops when the job has completed and its available log has been read. Stop following with Ctrl-C. GitHub may only publish logs after the job finishes. Add `--machine <machine-id>` for a remote host; `--json` prints one response per chunk.

Agents can use MCP `vectis_job_logs` with `{bindingId, jobId, after?}`. Pass the returned `next` as `after` to read the next chunk. Both cursors are absolute, nonnegative integer byte offsets in GitHub's UTF-8 log. The response includes `text`, `next`, the observed job `status`, `complete` and `truncated`. `complete` is true only when the job is completed and the cursor reaches the end. `truncated` means earlier unread bytes fell outside the retained window and were skipped.

Logs are fetched from GitHub on demand without storing log archives. Remote reads use temporary inspection responses that expire after 60 seconds. Vectis reads within the last 4 MiB, uses UTF-8 safe chunks of at most 32 KiB, and preserves GitHub's masking. Downloads request one chunk at a time with bounded HTTP Range requests when supported; otherwise they stream the file with a 64 MiB download limit and retain only its tail. GitHub access, expired logs or the download limit can prevent a read.

## Cancel

Cancel a runner from its operation in **Overview**, or:

```sh
vectis operation cancel <operation-id>
vectis operation wait <operation-id>
```

Cancelling stops the VM, then removes the GitHub registration. The cancel request returns before cleanup finishes; the original operation reports the outcome. Pausing the machine only stops new VMs.

## When a runner is lost

GitHub reports "The self-hosted runner lost communication with the server" when a runner stops answering mid-job. If Vectis loses its connection to the VM, or the runner process exits unsuccessfully, it collects evidence before it stops the VM, because stopping destroys it. The failed operation keeps it as `diagnostics`, shown in the activity's details in the app and in `vectis operation get <operation-id> --json`:

- the runner's last output, or the SSH error that ended the connection;
- the host's view of the VM network: its ARP entry and interfaces;
- from the guest, if it still answers: uptime, memory, the kernel log tail (when readable) and the runner's own log tail.

An unreachable guest is reported as such, with SSH's reason (timeout, no route, refused). The text is capped at 16 KiB, contains no runner credentials, and is not collected for cancelled or successful runners. On Windows guests only uptime and the runner log are read, and that path is untested.

## Recover after a crash

If the Mac or the service stopped abruptly, an operation or VM can end up `action_required`. Interrupted runner operations report `runner_recovery_pending`. On startup and during periodic recovery, Vectis checks the owned VM's exit evidence. Once the instance is stopped or absent, it reconciles the cloud lease and releases the registration automatically. A VM that may still be running, or an unconfirmed cloud release, keeps the operation unresolved.

If deleting an owned VM's files fails after its process exits, Vectis retains an exit receipt so reconciliation can retry the file cleanup.

```sh
vectis instance reconcile <instance-id> --wait
vectis runner reconcile <operation-id> --wait
```

The app offers the same actions as **Reconcile** in **Overview**. Until an interrupted VM is reconciled, the Mac starts no new VMs and offers no runner slots. Do not start new runners to work around an unresolved one.

For interrupted runners, `runner_registration_uncertain` and `runner_cleanup_required`, recovery retries while connected to the cloud, with delays of 1, 2, 4, 8, 16 and then 30 minutes, capped at 30 minutes. The retry schedule survives service restarts. After 24 hours, the operation remains `action_required` with a message and a next step for manual reconciliation. A stopped runner can still be busy on GitHub, usually for up to 15 minutes until GitHub releases its job; `runner_busy` leaves cleanup unresolved until a later retry succeeds.

A refused assignment retains its policy reason during cleanup. After manual or automatic reconciliation succeeds, the runner operation ends as `failed` with `runner_assignment_rejected` and the original refusal message. Offline runners retain `failed` with `runner_offline` after delayed cleanup. Other interrupted runners end as `cancelled` with `runner_interrupted`; this does not establish the GitHub job result. Requests interrupted before startup or registration began end as `failed` with `runner_interrupted`.

Runner reconciliation also works when registration stopped before creating a cloud lease. After confirming VM cleanup, Vectis records the request as released in the cloud so a delayed registration cannot create a duplicate runner. If the cloud cannot confirm this, the operation stays unresolved.

Registration failures confirmed to have no remaining cloud registration end as retryable `failed` with `runner_registration_failed`. A lost response is reconciled before retrying; unavailable reconciliation stays `action_required`. Approval-required results retain their existing manual next steps.
