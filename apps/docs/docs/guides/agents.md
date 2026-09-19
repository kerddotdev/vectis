---
title: Agents
description: Give coding agents the Vectis skill and MCP server so they can prepare environments, connect repositories and diagnose jobs.
---

Agents use the same service and the same commands as you: the `vectis` CLI with JSON output, or the `vectis-mcp` server. The Vectis skill teaches them the workflow and the rules, such as never approving a pairing request on your behalf.

First [install the command line tools](/docs/get-started/install#command-line-tools) from the app, so `vectis` and `vectis-mcp` are on your PATH.

## Claude Code

Install the plugin, which contains the skill and registers the MCP server:

```text
/plugin marketplace add kerddotdev/vectis
/plugin install vectis@vectis
```

Or add only the MCP server:

```sh
claude mcp add vectis -- vectis-mcp
```

## Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.vectis]
command = "vectis-mcp"
```

Copy [`skills/vectis`](https://github.com/kerddotdev/vectis/tree/main/skills/vectis) into your Codex skills directory to add the skill.

## Cursor and other MCP clients

Any client that starts stdio MCP servers can run `vectis-mcp`. For Cursor, add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vectis": { "command": "vectis-mcp" }
  }
}
```

The skill is a plain [`SKILL.md`](https://github.com/kerddotdev/vectis/blob/main/skills/vectis/SKILL.md) that works with any agent that reads skills.

## MCP tools

| Tool                                                           | Use                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `vectis_capabilities`                                          | Supported commands and queries, with the command schema                             |
| `vectis_status`                                                | Machine, environments, VMs, recent operations and cloud connection                  |
| `vectis_command`                                               | Submit a command with an idempotency key                                            |
| `vectis_operation`, `vectis_wait`                              | Read one operation, or wait for it; a wait that times out returns the current state |
| `vectis_logs`                                                  | The newest service log lines                                                        |
| `vectis_repositories`, `vectis_jobs`, `vectis_github_accounts` | Connections with their labels, job results, linked accounts                         |
| `vectis_storage`, `vectis_doctor`                              | Disk usage and runtime diagnostics                                                  |
| `vectis_github_connect`                                        | The page that links GitHub and installs the App                                     |
| `vectis_service`, `vectis_cloud`                               | Login service and pairing, on the Mac itself only                                   |
| `vectis_machines`                                              | Your Macs, after `vectis login`                                                     |

To let an agent control another Mac, sign in once with `vectis login` and start the server with `vectis-mcp --machine <machine-id>`. A remote session never falls back to the local Mac.

## Rules agents follow

- Humans approve pairing, sign-in and GitHub linking in the browser. Agents hand over the link and wait.
- An accepted operation is not a finished one. Agents report the final status, and follow `nextStep` for `action_required`.
- Agents reuse an idempotency key only to retry the exact same command.

## Documentation for agents

[`llms.txt`](/docs/llms.txt) indexes every page, [`llms-full.txt`](/docs/llms-full.txt) contains all of them, and appending `.md` to any page URL returns its Markdown.
