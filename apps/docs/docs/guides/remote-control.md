---
title: Remote control
description: Control your own Vectis machines through the desktop, CLI, or MCP.
---

The host service keeps ownership of VMs and jobs. Remote clients send commands through Convex; hosts connect outward and do not need a public port. A remote controller can manage machines owned by the same Vectis account. Pair each host first using the [local setup guide](/docs/guides/local-setup/).

## Sign in from the CLI

Configure `VECTIS_KEYCHAIN_HELPER` with the built Keychain helper, then run:

```sh
pnpm vectis login --name "My CLI" --json
```

Open the returned private link yourself, sign in, compare the verification code, and approve remote control. Do not share the link. The command returns `action_required` until you finish the browser step. Then run:

```sh
pnpm vectis login finish --json
pnpm vectis machine list --json
pnpm vectis status --machine <machine-id> --json
pnpm vectis doctor --machine <machine-id> --json
```

Use the cloud machine `id` from `machine list`, not its `localId`. Add the same `--home` to every command when using a separate controller directory. This directory does not require a running local service. Controller credentials stay in Keychain, expire after 90 days, and can be revoked from the browser connection page or with `vectis logout`.

## Submit and observe commands

Use `--machine` for each remote command. Omitting it selects the local service. An unavailable remote machine never causes a fallback to local execution.

```sh
pnpm vectis pause --machine <machine-id> --key <unique-request-key> --json
pnpm vectis operation get <operation-id> --machine <machine-id> --json
pnpm vectis operation wait <operation-id> --machine <machine-id> --timeout 60000 --json
pnpm vectis operation cancel <operation-id> --machine <machine-id> --json
```

An accepted command is durably queued, not completed. Hosts claim commands and report execution separately. Retry the same request key only with the same command. Cancellation before delivery prevents execution; cancellation after delivery requires the host to observe the request and finish cleanup. Already completed operations keep their actual outcome.

Read-only requests require an online host. Their cloud responses are bounded and expire after 60 seconds. Completed command details are retrieved from the host; when it is offline, the cloud summary explicitly reports that the full result remains local. GitHub logs and artifacts retain normal GitHub behavior.

File paths, image directories, CPU and memory limits refer to the selected host. Remote service installation, startup, and shutdown are not available: configure the background service on that host locally.

## Desktop

Use **Sign in for remote control**, complete browser approval, then **Finish sign-in** and **Refresh machines**. Select an online machine from **Control machine**. The same environment, repository, storage, diagnostic, and runner controls now address that host. Switching hosts clears forms and previous host data. Local file pickers are disabled while a remote host is selected; enter paths that exist on that host.

**This Mac (local)** restores direct local control. Closing the desktop leaves host services and jobs running.

## MCP

After CLI login in the same home directory, launch:

```sh
pnpm mcp --home <controller-directory> --machine <machine-id>
```

Set `VECTIS_KEYCHAIN_HELPER` in the MCP process environment. Start with `vectis_capabilities` to inspect the selected target and available commands. Remote sessions omit local service and machine-pairing tools. `vectis_command`, reads, and `vectis_wait` use the same remote client as the CLI and desktop. Cancelling a wait does not cancel its operation.
