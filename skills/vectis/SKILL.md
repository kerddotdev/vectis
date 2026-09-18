---
name: vectis
description: Configure and diagnose local GitHub Actions runner environments through Vectis CLI or MCP. Use when managing Vectis machines, environments, operations, or workflow migration previews.
---

# Vectis

Vectis runs CI workloads on the user's machines. Discover the installed build before selecting commands: release capabilities can differ from the documentation or intended roadmap.

## Discover

Run `vectis --help`, `vectis capabilities --json`, and `vectis doctor --json`. In a source checkout, use `pnpm build` followed by `pnpm vectis` instead of an installed `vectis` binary.

With MCP, list tools and call `vectis_capabilities`. Discovery works without a running service; state and mutations require one. `vectis_status` reads the same state as the CLI.

## Work with the local service

Use one consistent `--home <directory>` for every CLI command in an isolated task. Start with `vectis service start --home <directory> --json`, then inspect `vectis status --home <directory> --json`. MCP accepts the same `--home` directory when its server starts. Never copy the local connection token into tool arguments or conversation text.

For mutations, use a stable `--key` or MCP `key`. Reuse it only when retrying the exact same command. `accepted` and `running` do not mean the requested work completed. Inspect the operation ID with `vectis operation get <id> --json` or wait with `vectis operation wait <id> --json`. CLI `--wait` observes completion directly.

All CLI commands are non-interactive. Use `--json` for parsing. `action_required` needs the reported next step; do not invent a successful setup or repeatedly submit new operations. Cancelling a wait does not cancel its operation. The generic `command --file <path>` and MCP `vectis_command` accept the discovered command schema.

Pausing stops new admission and leaves existing work running. Stopping an instance is a separate mutation. After a crash, use `instance reconcile <id>` only for interrupted instances; Vectis requires process-exit evidence before cleanup.

## Discover repository connections

After machine pairing and browser GitHub linking, use `vectis repository list --json` or MCP `vectis_repositories`. The response identifies repositories currently connected to this machine and their environment IDs. Cloud or account authorization failures are errors; do not interpret them as an empty repository list. A binding does not prove that an image is ready to run a job. Discover verified identities with `github accounts --json`, then connect a prepared local environment with `repository connect <name> --account <id> --environment <id> --wait --json`. Never infer account ownership from a display name.

## Run and observe jobs

`runner run <binding-id> --key <stable-key> --json` starts one disposable runner. Add `--job-id <job-id>` when admission should require that specific job to remain queued with matching labels; GitHub still decides which compatible job reaches the runner. Runner lifecycle success confirms cleanup, not the GitHub job's conclusion. Read `job list <binding-id> --json` or MCP `vectis_jobs` for observed GitHub results. Use `job scan <binding-id> --wait --json` to discover missing queued and running jobs. Periodic scans also run for automatic bindings; an incomplete scan is `action_required`, not proof that the entire queue was recovered. Recover a known missing or stale job with `job refresh <binding-id> <job-id> --wait --json`.

`repository enable-auto <binding-id> --wait --json` authorizes future matching queued work on the machine. `repository disable-auto` disables that admission; it does not stop running work. The current scheduler admits one automatic runner per idle machine and does not blindly retry failed or interrupted attempts. Only enable it within the user's authorized repository and workload scope.

Use `operation cancel <operation-id>` to request runner cleanup or cancel waiting for a job refresh. Inspect the original operation afterward. For an interrupted runner, verify its VM has stopped before `runner reconcile <operation-id>`; never hide uncertain cleanup by submitting fresh runner requests.

## Prepare Ubuntu

On an idle Apple Silicon host with the Apple helper and qemu-img configured, use `environment prepare-linux <id> --image-directory <existing-path> --storage-path <existing-path> --cpu 2 --memory-mib 4096 --disk-gib 32 --json`. Follow its operation; download acceptance is not image readiness. Preparation blocks other VM admission until it finishes or stops. For `action_required`, inspect the reported image directory and use `environment resume <setup-id>` after fixing prerequisites. Never delete a setup directory to bypass missing process-exit evidence. Successful setup registers an environment; repository connection and a real verification job remain separate steps.

## Configure resources and storage

Use `environment configure <id> --cpu <count> --memory-mib <MiB> --storage-path <absolute-directory> --wait --json`. Omit fields that should remain unchanged. Changes apply to future instances; running instances retain their original resource reservations and directory. The VM storage directory is independent of the service's `--home` state directory. Select an existing writable directory. Vectis does not recreate a missing selected directory, so reconnect an unavailable external drive before retrying.

Use the same optional resource flags on `environment start <id>` to override settings for a single VM without changing environment defaults. The service validates both the individual VM and the combined host budget before starting it.

`vectis storage --json` or MCP `vectis_storage` reports base images and instances separately. Distinguish virtual disk capacity, file size, and allocated host blocks. Copy-on-write blocks may be shared across images, so summing allocated values can overstate exclusive physical usage. Host file breakdown is not a guest filesystem breakdown; check the reported availability.

## Diagnose and migrate

Start with machine state, operation status, the error code and its `nextStep`. Missing runtime, missing image, insufficient capacity, and interrupted instances require different remedies. Registering a prepared image does not prove the guest OS or GitHub runner is ready.

For an isolated YAML snippet, `migration.preview` only returns proposed YAML. For a connected repository, use `migration analyze <binding-id> --wait --json` and inspect every changed file and finding. With user authorization to create the PR, use `migration publish <preview-id> --wait --json`. Publication requires successful runner evidence for the same environment revision and never merges. A conflicting branch or stale preview requires inspection, not a force push. An uncertain publication may already have created the PR; retry the same preview after checking GitHub. Do not infer ARM64 compatibility from an x64 runner label. Public fork workflow approval remains a GitHub maintainer decision.

Only advertise operations present in capability discovery. Do not claim cloud pairing, automatic PR creation, a completed GitHub job, or support for an unverified guest based on a successful process launch.
