---
title: Repositories and labels
description: Connect repositories to a Mac, choose the runs-on label, and meet the rules for organizations and public repositories.
---

A connection ties one GitHub repository to one environment on one Mac. A repository can have several connections, for example Ubuntu on one Mac and macOS on another.

## Before you connect

- The Mac is [connected to your account](/docs/get-started/quickstart#2-connect-this-mac-to-your-account).
- Your GitHub account is linked, and the Vectis GitHub App is installed on the repository's owner with access to the repository.
- The environment exists on that Mac. It does not have to be ready yet, but jobs only run once it is.

## Connect

**App:** **Repositories > Connect a repository**, then pick the GitHub account, an optional organization, the repository and the environment.

**Web:** **Repositories > Connect a repository** at [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect), where you also pick the Mac.

**CLI:**

```sh
vectis github accounts --json
vectis repository connect <repository> --account <account-id> --environment <environment-id> [--owner <organization>] --wait
vectis repository list --json
```

`repository list` shows each connection's ID (the binding ID used by other commands) and its `runsOn` label. Connecting the same repository and environment again reuses the connection.

## Choose the runs-on label

Each environment has one Vectis label: `vectis-<environment-id>`. The app, the web page and `repository list` show it next to every connection.

```yaml
runs-on: vectis-ubuntu
```

A job reaches Vectis when its `runs-on` labels include the Vectis label and nothing Vectis does not offer. Besides the Vectis label, a job may list only these, which every Vectis runner also carries:

- `self-hosted`
- the guest's OS: `Linux`, `macOS` or `Windows`
- `ARM64`

```yaml
runs-on: [self-hosted, Linux, ARM64, vectis-ubuntu] # also works
runs-on: [self-hosted, linux, x64, vectis-ubuntu] # never runs on Vectis: x64
runs-on: ubuntu-latest # GitHub-hosted, not Vectis
```

Guests are ARM64. Jobs that need x86-64 binaries or containers do not work unchanged; [workflow migration](/docs/guides/migrations) only moves jobs that can run on ARM64.

## Organization repositories

Select your own linked GitHub account and give the organization separately (`--owner <organization>`, or the owner field in the app and on the web). Your GitHub account needs **admin** permission on the repository. Organization membership alone is not enough. Vectis checks this again whenever it registers a runner, reads jobs or opens a migration pull request.

## Public repositories

Anyone can open a pull request against a public repository, and its workflows would run on your Mac. Vectis therefore requires this GitHub setting before it connects a public repository or registers a runner for it:

**Settings > Actions > General > Approval for running fork pull request workflows from contributors: Require approval for all external contributors.**

A maintainer then approves each outside contributor's run on GitHub after reviewing the change. Vectis never changes this setting and never approves a run. Forks do not inherit your runners. Review outside code the way you would for any self-hosted runner: approval is the protection, not a guarantee against hostile code.

## Disconnect

**App:** the connection's menu, **Disconnect repository**. **Web:** **Disable connection**. **CLI:** `vectis repository disconnect <binding-id>`.

Disconnecting stops new runners for that connection. Running jobs finish normally. The GitHub App installation and your workflows stay as they are; jobs that still ask for the label wait until another connection provides it.
