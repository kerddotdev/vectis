# Contributing to Vectis

Thanks for helping. Read [AGENTS.md](AGENTS.md) first: it describes what Vectis never compromises on and applies to human and agent contributors alike.

## Before you start

- Open an issue before large changes so we can agree on the approach.
- Keep each pull request to one concern. If the description says "also", split it.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Development

Build from source with Node 24 and pnpm:

```sh
pnpm install
pnpm build
pnpm vectis --help --home "$(mktemp -d)"
```

Always use a temporary home. See [Build from source](https://vectis.kerd.dev/docs/self-hosting/build-from-source) for the desktop app, native helpers, and your own cloud deployment.

Before pushing, run:

```sh
pnpm check
```

## Pull requests

- Changes reach `main` only through pull requests. Nobody pushes to `main` directly.
- Titles use conventional commits in plain language, for example `fix(runner): release capacity while guest setup waits`. Pull requests are squash merged, so the title becomes the commit message.
- Every affected surface needs to be covered: contract, service, CLI, desktop, MCP, remote control, and docs. The checklist in the pull request template walks through them.

## CI

Vectis tests itself: CI runs on Vectis runners, in disposable VMs on a maintainer's Mac. That has two consequences:

- A maintainer must approve workflow runs for pull requests from forks before they start.
- When that Mac is asleep or busy, checks wait in the queue. They are not failing; they start once the machine is available.
