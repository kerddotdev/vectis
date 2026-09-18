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

## Configure resources and storage

Use `environment configure <id> --cpu <count> --memory-mib <MiB> --storage-path <absolute-directory> --wait --json`. Omit fields that should remain unchanged. Changes apply to future instances; running instances retain their original resource reservations and directory. The VM storage directory is independent of the service's `--home` state directory. Select an existing writable directory. Vectis does not recreate a missing selected directory, so reconnect an unavailable external drive before retrying.

`vectis storage --json` or MCP `vectis_storage` reports base images and instances separately. Distinguish virtual disk capacity, file size, and allocated host blocks. Copy-on-write blocks may be shared across images, so summing allocated values can overstate exclusive physical usage. Host file breakdown is not a guest filesystem breakdown; check the reported availability.

## Diagnose and migrate

Start with machine state, operation status, the error code and its `nextStep`. Missing runtime, missing image, insufficient capacity, and interrupted instances require different remedies. Registering a prepared image does not prove the guest OS or GitHub runner is ready.

For workflow migration, use the advertised `migration.preview` command and inspect its findings and returned YAML. It does not write a branch or PR. Do not infer ARM64 compatibility from an x64 runner label. Public fork workflow approval remains a GitHub maintainer decision.

Only advertise operations present in capability discovery. Do not claim cloud pairing, automatic PR creation, a completed GitHub job, or support for an unverified guest based on a successful process launch.
