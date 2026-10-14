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

A Mac runs up to five runners at once by default; change it in **Settings** or with `vectis machine configure --max-runners <N>` (1 to 16). The Mac also never starts more than its CPU and memory allow: all running and starting VMs together get at most every CPU core and 75 percent of the memory, and at most two macOS VMs run at a time. It counts with your largest ready environment, so with a 6 CPU environment on a 14 core Mac two jobs run at once, whatever the limit says. `vectis status` and the Settings view show how many fit right now; give the environment fewer CPUs or less memory with `vectis environment configure` to run more.

Before booting a VM, and again before registering the runner, Vectis checks with GitHub that the job is still queued. GitHub may hand the runner a different job with the same labels. If the original job is still queued after a runner succeeded, or a minute after it failed, Vectis starts another, at most three times per job. It never retries an interrupted or cancelled runner on its own, with one exception: a job that waits for an environment approval or a concurrency group gets a runner once GitHub queues it.

Automatic runners are off until you turn them on, per connection. These CLI commands wait for the setting to be applied without needing `--wait`, and return a nonzero exit code if it fails or needs attention.

## Manual runners

Start one runner yourself with **Start runner** on the connection, or:

```sh
vectis runner run <binding-id> --key <any-unique-key> --json
vectis runner run <binding-id> --job-id <github-job-id> --json   # only if that job is still queued
```

A manual runner waits up to six hours for a job.

## Read job results

A runner operation that succeeded means the VM ran and was cleaned up. It does not say whether the job passed. The job's result comes from GitHub:

- **App:** open a connection in **Repositories** to see its recent jobs.
- **CLI:** `vectis job list <binding-id> --json` returns the latest 100 jobs with their GitHub status and conclusion.

Job states arrive through GitHub webhooks. If one seems missing or stale:

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

If the Mac or the service stopped abruptly, an operation or VM can end up `action_required`. Vectis never guesses: it cleans up only after it has evidence that the VM process exited.

```sh
vectis instance reconcile <instance-id> --wait
vectis runner reconcile <operation-id> --wait
```

The app offers the same actions as **Reconcile** in **Overview**. Until an interrupted VM is reconciled, the Mac starts no new VMs and offers no runner slots. Do not start new runners to work around an unresolved one.
