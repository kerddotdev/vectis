---
title: Run a disposable runner
description: Start, observe, cancel, and reconcile a service-managed GitHub runner.
---

The local service can run one official GitHub Actions runner in a disposable guest. This development path requires a paired machine, a connected private personal repository, and a prepared ARM64 environment with pinned guest SSH access. Organization and public repository runner policies are not enabled yet.

After pairing the machine and linking a GitHub identity in the browser, connect a prepared environment:

```sh
vectis github accounts --json
vectis repository connect <repository-name> --account <account-id> --environment <environment-id> --wait --json
```

The account ID must come from verified account discovery. The connection checks the current GitHub App installation and repository access. Repeating the same connection reuses its binding. The desktop provides the equivalent account, repository and environment form under Connections; MCP accepts `repository.connect`.

Discover the repository binding, then request a runner:

```sh
vectis repository list --json
vectis runner run <binding-id> --key <stable-request-key> --json
vectis operation get <operation-id> --json
vectis operation wait <operation-id> --timeout 3600000 --json
```

The service starts a clean VM, checks its architecture and clock, installs the checksum-verified runner, and requests a repository-scoped JIT configuration from the GitHub App. The App private key stays in the cloud. The local operation record never contains the JIT configuration.

A workflow must target the environment label `vectis-<environment-id>`, along with the appropriate OS and ARM64 labels. For example, a macOS environment named `macos-26-arm64` uses:

```yaml
runs-on: [self-hosted, macOS, ARM64, vectis-macos-26-arm64]
```

GitHub assigns queued jobs to available runners. Starting a runner does not assign it to a particular job or automatically dispatch a workflow. Automatic admission can be enabled per binding as described below. Use the [workflow migration guide](/docs/guides/migrations/) to preview repository changes and create a PR. The manual runner task is bounded to six hours after listener startup.

A successful Vectis operation confirms that its runner process completed and cleanup succeeded. Use `vectis job list <binding-id> --json`, MCP `vectis_jobs`, or **Connections > Refresh GitHub jobs** to read the latest 100 observed GitHub jobs for the repository. These records come from signed GitHub webhooks and include the GitHub conclusion. If an event has not arrived, the record can be absent or stale. Use `vectis job refresh <binding-id> <job-id> --wait --json` to recover a known job directly from the repository API. Use `vectis job scan <binding-id> --wait --json` or **Discover missing jobs** to discover queued and running workflows without knowing a job ID. The scan also revisits previously active runs. Automatic bindings request this read periodically, at most once per repository per five-minute scheduling window while a connected machine is unpaused. Large queues or API limits can produce `action_required` with a partial scan; use known job IDs to recover specific missing records. Scans never approve fork workflows. Check the GitHub Actions run for the job's actual result. The listener's exit code alone is not a job result.

## Automatic admission

```sh
vectis repository enable-auto <binding-id> --wait --json
vectis repository disable-auto <binding-id> --wait --json
```

Automatic mode is disabled until explicitly enabled for a repository binding. A connected, unpaused, idle machine checks queued demand on its heartbeat. Admission requires the environment's Vectis label and all other requested labels to match. The current scheduler admits one automatic runner per idle machine; manual VM requests still share the host resource budget.

Before starting a VM, and again before registering its runner, the service reads the job directly from GitHub. Completed or cancelled demand does not start a new runner. GitHub can assign the runner to a different compatible queued job. If the original demand still waits after verified successful cleanup, the scheduler permits at most three sequential attempts. Failed, interrupted or explicitly cancelled attempts require inspection rather than automatic retry.

Disabling automatic mode stops future admission, including queued requests that have not started. Pausing the machine leaves already running jobs alone. An offline machine is not treated as available capacity. Repeated heartbeats and competing machines cannot create a second reservation for the same active demand.

The desktop offers the same mode switch under Connections. MCP accepts `repository.automatic` through `vectis_command`. To request a single runner guarded by a known job's current state, use `runner run <binding-id> --job-id <job-id>`.

## Cancel and recover

```sh
vectis operation cancel <operation-id> --json
vectis operation wait <operation-id> --json
```

Cancellation first stops the owned VM, then removes its GitHub registration. The cancellation request finishing does not mean cleanup has finished; inspect the original runner operation. Pausing the machine leaves existing runners running. Cancelling a CLI wait also leaves the runner running.

After a service restart or uncertain cleanup, inspect the original operation and its instance. Reconcile an interrupted instance only after the runtime confirms process exit, then reconcile its runner:

```sh
vectis instance reconcile <instance-id> --wait --json
vectis runner reconcile <operation-id> --wait --json
```

Runner reconciliation finds the original cloud lease by its stable request key. It cannot delete another binding's runner or remove a registration while VM exit is unconfirmed. Missing cloud evidence remains `action_required`; do not submit fresh runner requests to hide that state.

In the desktop, use **Connections > Start runner** and follow the operation in **Overview**. Active operations offer **Cancel operation**; interrupted ones offer **Reconcile runner**. MCP exposes these same operations through `vectis_command` and the shared capability schema.
