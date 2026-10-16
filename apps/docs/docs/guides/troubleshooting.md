---
title: Troubleshooting
description: What to check when a job keeps waiting, a VM does not start, or an operation fails.
---

## A job stays queued

Start with `vectis repository readiness --binding <binding-id> --json` (MCP `vectis_readiness`). Follow each blocked check's `code` and `nextStep`; an `unknown` check could not be verified. Disabled automatic runners appear as attention. Readiness checks prerequisites, so also check capacity and workflow labels below.

1. **Is the Mac available?** `vectis status --json` shows `machine.paused` and `cloud.state`. A paused Mac, a Mac whose cloud connection is not `connected`, or a Mac that is asleep takes no new jobs. Resume it with `vectis resume`.
2. **Is the Mac busy?** A Mac runs up to its **Concurrent VMs** setting at once (5 by default; change it with `vectis machine configure --max-runners <N>`), as long as all VMs together fit within the host's CPU cores and 75% of its memory. It starts none while an environment is being prepared or an interrupted instance is unresolved. The job starts when a slot and resources are free. See [Limits and boundaries](/docs/guides/limits).
3. **Are automatic runners on?** Without them nobody starts a runner. Turn on **Automatic** for the connection, or start one with `vectis runner run`.
4. **Do the labels match?** The workflow's `runs-on` must contain the connection's `runsOn` label and nothing besides `self-hosted`, the OS label and `ARM64`. See [the label rules](/docs/guides/repositories#choose-the-runs-on-label).
5. **Is the environment ready?** `vectis status --json` lists environments with their `state`.
6. **Is the run waiting for approval?** Runs from outside contributors on public repositories wait until a maintainer approves them on GitHub.
7. **Can the GitHub App reach the repository?** The App must be installed on the owner with access to the repository. Link GitHub again on the connect page to refresh what Vectis sees.
8. **Did Vectis miss the job?** Run `vectis job scan <binding-id> --wait`.

Jobs with more than 100 labels or a label longer than 100 characters are recorded but cannot match Vectis runners. Unknown GitHub job statuses are retained as waiting until a scan or refresh supplies a known status.

## An operation failed or needs you

Every operation ends with a status, a message and, when you need to act, a `nextStep`:

```sh
vectis operation get <operation-id> --json
vectis logs --lines 200 --json
```

Displayed logs, stored operation details and retained runner and preparation diagnostics redact recognized credentials.

For slow runners, inspect `result.phases` on the runner operation, either directly or inside `vectis activity get <activity-id> --json`. Compare `vm_start`, `guest_ready`, `runner_install` and `registration` to find startup costs; `cleanup` measures the stop and release attempt. Each duration is `endedAt - startedAt`. A missing end is still running or interrupted, and older records may omit phases. Job timing starts at the first GitHub busy observation, normally polled every 30 seconds, so short jobs can be missed. These local timings do not measure the full GitHub queue. See [Read phase timings](/docs/guides/runners#read-phase-timings) for the complete phase list, overlap and retention rules.

The app shows the same in **Overview** and the service log in **Diagnostics**. `action_required` means completion is unconfirmed; follow its `nextStep`. Runner cleanup may still be retried automatically.

GitHub reads, runner deletion and installation token creation retry transient failures up to four attempts within a 45-second budget per request. Retries respect GitHub rate limit headers. `github_unavailable` means GitHub remained unavailable; `github_rate_limited` means the rate limit could not be cleared within that budget. Wait and retry. Side-effecting POST requests are never automatically retried; an ambiguous run command keeps `run_command_unconfirmed`, and an ambiguous runner registration still requires reconciliation.

An operation that stays in **Needs you** after you have read it, usually because the service restarted before it finished, can be closed with **Dismiss** in the app or `vectis operation cancel <operation-id>`. It ends as `cancelled` and nothing else changes. Two cases keep their own way out instead: an interrupted runner is reconciled once its VM is confirmed stopped, and an image preparation is resumed or discarded.

After a restart, interrupted runners report `runner_recovery_pending`. Once the VM is verified stopped or absent, Vectis automatically reconciles the cloud lease and releases the runner. Recovery also covers `runner_cleanup_required` and `runner_registration_uncertain`. Connected retries use exponential backoff from 1 minute to 30 minutes for up to 24 hours, preserving the schedule across service restarts. GitHub can keep a stopped runner busy until it releases the job, usually within 15 minutes; `runner_busy` means cleanup must wait. An unconfirmed VM exit or cloud release keeps the operation `action_required`. After the retry window, use `vectis runner reconcile <operation-id>` once the VM is confirmed stopped; the result includes this next step.

If Vectis refused the assigned job, the cleanup result keeps the original reason in `cause`. Successful reconciliation ends that runner operation as `failed` with `runner_assignment_rejected` and the original refusal message. Offline runners end as retryable `failed` with `runner_offline`, including after delayed cleanup. Other interrupted runners end as `cancelled` with `runner_interrupted`; check GitHub separately for the job result. A request interrupted before startup began ends as `failed` with `runner_interrupted`.

`vectis status --json` groups related operations into `activities`. A preparation keeps one activity across setup attempts; a runner activity includes its VM start and cleanup. Preparation status follows the latest attempt, while a runner follows its root operation. A successful discard cancels the preparation activity; the discard operation itself stays `succeeded`. Operation IDs and request keys stay unchanged.

Status includes every unfinished operation and activity, including `action_required`, plus the newest 100 terminal operations and 100 terminal activities. It includes every non-stopped instance and the newest 20 stopped instances. These are display windows, not the complete retained history. Use `vectis operation get <id> --json` or `vectis activity get <id> --json` for an older retained record; waits poll only the requested operation. `vectis activity list` reads activity summaries directly. The desktop fetches an opened activity's full steps separately.

Stopped instance records older than 24 hours are removed beyond the newest 20, using their stop time when available and creation time for older records. This removes only stopped records, not guest files, unfinished work or request-key receipts. Replaying a retained stop request still returns its original operation; an expired operation's key remains reserved.

Runner activities keep two separate optional facts: `subject.requestedJob` is the job that requested capacity, and `subject.actualJob` is the job observed on that registered runner. GitHub can assign a different job. Each may include `name`, `workflowName` and `htmlUrl` when GitHub provides them; a missing actual job means its identity is still unknown. Job failure does not make a successful runner lifecycle fail, and job success does not hide a cleanup failure.

Idle runners drain after 5 minutes when their requested job no longer needs capacity; manual runners without a requested job use the same window. GitHub reporting offline or missing for 2 consecutive minutes, or continuous status read failures for 15 minutes, stops a listening runner with `runner_offline`. Registration attempts with confirmed cleanup can fail retryably with `runner_registration_failed`; unresolved registration still requires reconciliation.

Actual job observation continues after the runner operation finishes and across service restarts. The service watches up to 20 of the newest eligible leases for activities created within the last 48 hours, stopping when the actual job completes. Already stored observations remain in activity history.

Use `vectis activity cancel <activity-id> --json` to request cancellation of every background task that activity still owns, then inspect its final status. It can also close an activity that only waits for a person, with the same preparation and runner recovery restrictions as `operation cancel`. The command works through remote control and MCP too.

Finished activity history expires after 30 days. Beyond the newest 300 completions, entries older than 24 hours expire too; the entire recent 24-hour tail stays. Unfinished or actively owned work stays. Terminal settings and automatic scans expire after 24 hours. Resource records, prepared environments and disks are unaffected. Reusing a pruned operation's request key returns `operation_expired`; use a new key for new work.

During an app update, an older service may omit `activities` and `revision`. Clients treat absent activities as an empty list and an absent revision as unknown change state.

## A job fails because a tool is missing in the guest

A prepared environment is a runner host, not a copy of a GitHub-hosted runner. It provides what a workflow needs to install its own toolchain: git, Docker, archive tools, a C and C++ toolchain and the libraries prebuilt binaries link against. Language runtimes, databases, browsers and cloud CLIs are not there. Each guide lists what its guest contains: [Linux](/docs/guides/linux-setup#what-the-image-contains), [macOS](/docs/guides/macos-setup#what-the-guest-contains), [Windows](/docs/guides/windows-setup#what-the-guest-contains).

Three ways out, in the order worth trying:

1. Use the matching `actions/setup-*` action. That is how hosted runners get their toolchains too.
2. Install it in a step. On Linux, `sudo apt-get install -y <package>` works without an `apt-get update` first.
3. Run the job in a container with `container:` in the workflow. The Linux guest runs Docker, so a job can bring a complete image of its own.

Nothing a job installs survives it: every VM is a fresh clone of the base image. On Linux the exact contents are in the guest at `/etc/vectis/toolchain-versions.txt`, on Windows at `C:\ProgramData\Vectis\toolchain.json`.

## The Mac says it was removed from its account

`vectis status --json` reports `cloud.state` as `removed`, and the app shows "Removed from account". Someone deleted this Mac on the account page, so its credential no longer works and Vectis stops retrying. Nothing local is lost.

1. Clear the saved connection with `vectis cloud disconnect`, or use **Disconnect** in the app's Connections view.
2. Connect again with `vectis cloud pair` or **Connect in browser** when you want the Mac back on an account.

Repository connections are not restored automatically; connect the repositories again afterwards.

## A VM does not start

- **Diagnostics** shows runtime configuration. `vectis doctor --json` adds typed `checks` for host support, executable runtime components and a writable service home, alongside the existing fields. Missing Windows-only components need attention when no Windows environment exists; otherwise they block. The app configures its own; from a source checkout, set them as described in [Build from source](/docs/self-hosting/build-from-source).
- The CPU and memory of all running VMs must fit the Mac. A VM may use at most 75% of its memory.
- VMs on an external drive need the drive connected and macOS permission for Vectis to access it.
- An interrupted VM blocks new ones until it is reconciled; see [Recover after a crash](/docs/guides/runners#recover-after-a-crash).

## Reporting a problem

Open an issue on [GitHub](https://github.com/kerddotdev/vectis/issues/new/choose) with `vectis --version`, `vectis doctor --json` and the relevant part of `vectis logs`. Remove anything private first. Report security problems privately as described in the [security policy](https://github.com/kerddotdev/vectis/blob/main/SECURITY.md).
