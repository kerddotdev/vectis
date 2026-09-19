<p align="center">
  <img src="apps/web/public/favicon.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">Vectis</h1>

<p align="center">
  GitHub Actions runners in disposable macOS, Ubuntu and Windows VMs on your own Apple Silicon Mac.
</p>

<p align="center">
  <a href="https://github.com/kerddotdev/vectis/actions/workflows/ci.yml"><img src="https://github.com/kerddotdev/vectis/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/kerddotdev/vectis/releases/latest"><img src="https://img.shields.io/github/v/release/kerddotdev/vectis" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kerddotdev/vectis" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="https://vectis.kerd.dev">Website</a> ·
  <a href="https://vectis.kerd.dev/docs">Documentation</a> ·
  <a href="https://vectis.kerd.dev/changelog">Changelog</a>
</p>

## Why Vectis

- **A clean machine for every job.** Each job boots a fresh copy of a prepared guest image, runs on a single-use runner, and the VM is deleted when it ends.
- **Your Mac stays in charge.** Guests get no host folders, no Docker socket and no host credentials. Build files and disks never leave the machine, and the host never opens an inbound port.
- **Built for agents too.** The app, the `vectis` CLI and the MCP server share one typed contract. Every command answers in JSON, and failures carry a stable code and a next step.

## Install

Requires an Apple Silicon Mac with macOS 15 or later.

1. Download [Vectis for macOS](https://github.com/kerddotdev/vectis/releases/latest/download/Vectis-arm64.dmg) and drag it to Applications.
2. Open it and choose **Install and start service**.
3. Optional: in **Diagnostics**, install the command line tools to get `vectis` and `vectis-mcp` on your PATH.

The app updates itself from GitHub Releases.

## Quickstart

1. Prepare an Ubuntu environment in **Environments**.
2. Connect the Mac to your account at [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect).
3. Link GitHub and install the Vectis GitHub App.
4. Connect a repository to the environment and turn on **Automatic**.
5. Use the environment's label in your workflow:

```yaml
jobs:
  test:
    runs-on: vectis-ubuntu
```

The [quickstart guide](https://vectis.kerd.dev/docs/get-started/quickstart) walks through each step, with CLI equivalents.

## Agents

Install the Claude Code plugin with the skill and MCP server:

```text
/plugin marketplace add kerddotdev/vectis
/plugin install vectis@vectis
```

Other agents can run `vectis-mcp` as a stdio MCP server and read [`skills/vectis`](skills/vectis/SKILL.md). See the [agents guide](https://vectis.kerd.dev/docs/guides/agents).

## How it works

A background service on your Mac owns the VMs, disks and credentials. When GitHub queues a job with a Vectis label, the hosted backend tells the Mac over its outbound connection; the Mac boots a VM from the prepared image, registers a just-in-time runner that takes exactly that job, and deletes the VM afterwards. The backend coordinates identity, GitHub access and remote commands. It never runs your code and never holds your machine's credentials.

## Self-hosting and building from source

Vectis is MIT licensed and every part of it is in this repository: the service, the apps, the Convex backend, the website and the GitHub App manifest. See [Build from source](https://vectis.kerd.dev/docs/self-hosting/build-from-source) and [Run your own cloud](https://vectis.kerd.dev/docs/self-hosting/cloud).

```sh
pnpm install
pnpm build
pnpm vectis --help
```

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The optional Windows runtime has its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
