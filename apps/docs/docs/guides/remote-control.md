---
title: Remote control
description: Control your own Vectis machines through the desktop, CLI, or MCP.
---

The host service keeps ownership of VMs and jobs. Remote clients send commands through Convex; hosts connect outward and do not need a public port. A remote controller can manage machines owned by the same Vectis account. Connect each Mac to your account first, as in the [quickstart](/docs/get-started/quickstart#2-connect-this-mac-to-your-account).

## Sign in from the CLI

With the [command line tools](/docs/get-started/install#command-line-tools) installed, run:

```sh
vectis login --name "My CLI" --json
```

Open the returned private link yourself, sign in, compare the verification code, and approve remote control. Do not share the link. The command returns `action_required` until you finish the browser step. Then run:

```sh
vectis login finish --json
vectis machine list --json
vectis status --machine <machine-id> --json
vectis doctor --machine <machine-id> --json
```

Use the cloud machine `id` from `machine list`, not its `localId`. Add the same `--home` to every command when using a separate controller directory. This directory does not require a running local service. Controller credentials stay in Keychain, expire after 90 days, and can be revoked from the browser connection page or with `vectis logout`.

## Submit and observe commands

Use `--machine` for each remote command. Omitting it selects the local service. An unavailable remote machine never causes a fallback to local execution.

```sh
vectis pause --machine <machine-id> --key <unique-request-key> --json
vectis operation get <operation-id> --machine <machine-id> --json
vectis operation wait <operation-id> --machine <machine-id> --timeout 60000 --json
vectis operation cancel <operation-id> --machine <machine-id> --json
```

An accepted command is durably queued, not completed. Hosts claim commands and report execution separately. Retry the same request key only with the same command. Cancellation before delivery prevents execution; cancellation after delivery requires the host to observe the request and finish cleanup. Already completed operations keep their actual outcome.

Read-only requests require an online host. Their cloud responses are bounded and expire after 60 seconds. Completed command details are retrieved from the host; when it is offline, the cloud summary explicitly reports that the full result remains local. GitHub logs and artifacts retain normal GitHub behavior.

File paths, image directories, CPU and memory limits refer to the selected host. Remote service installation, startup, and shutdown are not available: configure the background service on that host locally.

## Desktop

In **Connections > Other Macs**, choose **Sign in with browser**, approve the request, then **Finish sign-in**. Select an online Mac from **Control machine** at the bottom of the sidebar. The same environment, repository, storage, diagnostic, and runner controls now address that host. Switching hosts clears forms and previous host data. Local file pickers are disabled while a remote host is selected; enter paths that exist on that host.

**This Mac (local)** restores direct local control. Closing the desktop leaves host services and jobs running.

## MCP

After `vectis login`, start the MCP server for a specific Mac:

```sh
vectis-mcp --machine <machine-id>
```

`vectis_machines` lists your Macs from a local session. Start with `vectis_capabilities` to inspect the selected target and available commands. Remote sessions omit local service and machine-pairing tools. `vectis_command`, reads, and `vectis_wait` use the same remote client as the CLI and desktop. Cancelling a wait does not cancel its operation.
