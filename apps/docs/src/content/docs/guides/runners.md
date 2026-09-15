---
title: Run a disposable runner
description: Start, observe, cancel, and reconcile a service-managed GitHub runner.
---

The local service can run one official GitHub Actions runner in a disposable guest. This development path requires a paired machine, a connected private personal repository, and a prepared ARM64 environment with pinned guest SSH access. Organization and public repository runner policies are not enabled yet.

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

GitHub assigns queued jobs to available runners. Starting a runner does not assign it to a particular job or automatically dispatch a workflow. Automatic demand scheduling and migration PR creation are still being integrated. The manual runner task is bounded to six hours after listener startup.

A successful Vectis operation confirms that its runner process completed and cleanup succeeded. Check the GitHub Actions run for the job's actual result. The listener's exit code alone is not a job result.

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

In the desktop, use **Connections > Start runner** and follow the operation in **Overview**. Active operations offer **Cancel runner**; interrupted ones offer **Reconcile runner**. MCP exposes these same operations through `vectis_command` and the shared capability schema.
