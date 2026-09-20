---
title: Troubleshooting
description: What to check when a job keeps waiting, a VM does not start, or an operation fails.
---

## A job stays queued

Check these in order. The first one that fails is usually the answer.

1. **Is the Mac available?** `vectis status --json` shows `machine.paused` and `cloud.state`. A paused Mac, a Mac whose cloud connection is not `connected`, or a Mac that is asleep takes no new jobs. Resume it with `vectis resume`.
2. **Is the Mac busy?** A Mac runs one automatic runner at a time and none while an environment is being prepared. The job starts after the current VM is gone.
3. **Are automatic runners on?** Without them nobody starts a runner. Turn on **Automatic** for the connection, or start one with `vectis runner run`.
4. **Do the labels match?** The workflow's `runs-on` must contain the connection's `runsOn` label and nothing besides `self-hosted`, the OS label and `ARM64`. See [the label rules](/docs/guides/repositories#choose-the-runs-on-label).
5. **Is the environment ready?** `vectis status --json` lists environments with their `state`.
6. **Is the run waiting for approval?** Runs from outside contributors on public repositories wait until a maintainer approves them on GitHub.
7. **Can the GitHub App reach the repository?** The App must be installed on the owner with access to the repository. Link GitHub again on the connect page to refresh what Vectis sees.
8. **Did Vectis miss the job?** Run `vectis job scan <binding-id> --wait`.

## An operation failed or needs you

Every operation ends with a status, a message and, when you need to act, a `nextStep`:

```sh
vectis operation get <operation-id> --json
vectis logs --lines 200 --json
```

The app shows the same in **Overview** and the service log in **Diagnostics**. `action_required` means Vectis stopped safely and is waiting for the step it describes.

An operation that stays in **Needs you** after you have read it, usually because the service restarted before it finished, can be closed with **Dismiss** in the app or `vectis operation cancel <operation-id>`. It ends as `cancelled` and nothing else changes. Two cases keep their own way out instead: an interrupted runner is closed by `vectis runner reconcile <operation-id>` once its VM is confirmed stopped, and an image preparation by resuming or discarding the setup.

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

- **Diagnostics** or `vectis doctor --json` lists the runtime components the service found. The app configures its own; from a source checkout, set them as described in [Build from source](/docs/self-hosting/build-from-source).
- The CPU and memory of all running VMs must fit the Mac. A VM may use at most 75% of its memory.
- VMs on an external drive need the drive connected and macOS permission for Vectis to access it.
- An interrupted VM blocks new ones until it is reconciled; see [Recover after a crash](/docs/guides/runners#recover-after-a-crash).

## Reporting a problem

Open an issue on [GitHub](https://github.com/kerddotdev/vectis/issues/new/choose) with `vectis --version`, `vectis doctor --json` and the relevant part of `vectis logs`. Remove anything private first. Report security problems privately as described in the [security policy](https://github.com/kerddotdev/vectis/blob/main/SECURITY.md).
