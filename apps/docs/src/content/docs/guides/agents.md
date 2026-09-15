---
title: Agent integration
description: Discover capabilities and control Vectis through the CLI, MCP, or skill.
---

Start with discovery instead of assuming a command or guest OS is ready:

```sh
pnpm vectis --help
pnpm vectis capabilities --json
pnpm vectis status --json
```

Use `--json` and a stable `--key` for mutations. Reuse a key only when retrying the same request. A command response containing `accepted` is not a success report. Inspect the operation's terminal state and follow a returned `nextStep` when configuration or recovery is required.

All current CLI commands are non-interactive. `--non-interactive` explicitly documents that intent. `--timeout` bounds waiting; cancelling a wait does not cancel the underlying operation.

## MCP

After `pnpm build`, configure a stdio MCP client with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/vectis/dist/apps/mcp/src/main.js"],
  "env": { "VECTIS_HOME": "/absolute/path/to/your/vectis-home" }
}
```

Discover tools, then call `vectis_capabilities`. `vectis_status` and `vectis_storage` inspect local state. `vectis_command` accepts the shared command schema and an idempotency key. `vectis_wait` observes completion. State-changing tools require the same running local service as the CLI.

## Skill

The repository's `skills/vectis/SKILL.md` is a portable skill for agents. Install it using your agent application's skill installer. It contains discovery, mutation, storage, and recovery guidance, without credentials or machine-specific configuration.

For direct documentation retrieval, read [`llms.txt`](/llms.txt). The `/docs/markdown/` files are generated from the same public Markdown that builds this site.
