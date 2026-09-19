---
title: Quickstart
description: From a freshly installed app to your first GitHub Actions job in a Vectis VM.
---

This walkthrough uses an Ubuntu guest, the fastest to prepare. Each step shows the app first and the CLI equivalent after it. You need the app [installed](/docs/get-started/install) with its service running, and a GitHub repository where you can change workflows.

## 1. Prepare an Ubuntu environment

In the app, open **Environments**, choose **Add environment**, select **Ubuntu 24.04** and pick two folders: one for the base image and one for the disposable VMs. Keep the suggested CPU, memory and disk, or adjust them. The ID you choose, for example `ubuntu`, becomes part of the runner label.

```sh
vectis environment prepare-linux ubuntu \
  --image-directory ~/VMs/images --storage-path ~/VMs/clones --wait --timeout 3600000
```

Vectis downloads the official Ubuntu cloud image, checks its SHA-256 and installs Git, Docker and the GitHub runner's dependencies. This takes a few minutes. Follow it in **Overview**. Details: [Prepare Ubuntu](/docs/guides/linux-setup).

## 2. Connect this Mac to your account

In **Connections**, choose **Connect in browser** under **This Mac**. Your browser opens [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect). Sign in, check that the verification code matches the one in the app, and approve. Back in the app, choose **Finish connecting**.

```sh
vectis cloud pair --json     # open the link it prints, compare the code, approve
vectis cloud finish --json
```

Approve only requests you started yourself, and never share the link.

## 3. Link GitHub and install the App

On the connect page, open **Overview** and follow the steps:

1. **Link GitHub** proves which GitHub account is yours.
2. **Install App** installs the Vectis GitHub App on the account or organization that owns your repository. Choose the repositories it may access.
3. **Link again to refresh** so Vectis sees the new installation.

The CLI prints the same page with `vectis github connect`.

## 4. Connect the repository

In the app, open **Repositories** and choose **Connect a repository**. Pick your GitHub account, the repository and the `ubuntu` environment. You can also do this on the connect page under **Repositories**, where you also choose which Mac runs the jobs.

```sh
vectis github accounts --json
vectis repository connect my-repo --account <account-id> --environment ubuntu --wait
```

For a repository owned by an organization, add `--owner <organization>`. Public repositories have extra requirements; see [Repositories and labels](/docs/guides/repositories#public-repositories).

## 5. Point a workflow at Vectis

Set `runs-on` to the label shown next to the connection, `vectis-<environment-id>`:

```yaml
jobs:
  test:
    runs-on: vectis-ubuntu
    steps:
      - uses: actions/checkout@v5
      - run: echo "Hello from a disposable VM"
```

## 6. Turn on automatic runners

In **Repositories**, switch **Automatic** on for the connection.

```sh
vectis repository enable-auto <binding-id> --wait
```

Push the workflow. Your Mac notices the queued job within a minute, boots a fresh VM, registers a single-use runner, runs the job and deletes the VM. Watch the operation in **Overview** and the job under the repository in **Repositories**, or on GitHub.

If the job keeps waiting, work through [Troubleshooting](/docs/guides/troubleshooting).

## Next

- Add a [macOS guest](/docs/guides/macos-setup) for Xcode builds.
- Move existing workflows over with [workflow migration](/docs/guides/migrations).
- Let an agent operate Vectis with the [skill and MCP server](/docs/guides/agents).
