---
title: Vectis
description: Local virtual machines for GitHub Actions, controlled by people and agents.
---

Vectis runs disposable virtual machines on your own Apple Silicon Mac. The local service owns each VM and its files. The CLI, desktop, and agent interfaces are designed to use the same control contract.

**This is a development build.** Desktop, CLI, and MCP share local and remote controls for environments, storage, repository connections, runner operations, and workflow migration. Browser connections handle machine pairing and GitHub identities. Signed desktop and standalone CLI packages can be built from source; see [development packages](/docs/guides/development-packages/). No public release is published yet.

Start with [local setup](/docs/guides/local-setup/), then choose [VM storage and resources](/docs/guides/storage/). Agents can use the [integration guide](/docs/guides/agents/) and generated [CLI reference](/docs/reference/cli/).

Ubuntu 24.04 ARM64, macOS 26 ARM64, and Windows 11 ARM64 guests have completed real GitHub Actions jobs with disposable-instance cleanup in development testing. Follow the separate [Linux](/docs/guides/linux-setup/), [macOS](/docs/guides/macos-setup/), and [Windows](/docs/guides/windows-setup/) preparation guides. macOS setup and OS permissions can require manual steps. Registering an image alone does not verify its toolchain or runner readiness.

The central service coordinates identity and remote commands. VM disks and build files stay on the host. Normal GitHub Actions logs, artifacts, and caches still follow GitHub's behavior.

## Read without a browser

Append `.md` to any page URL to read its Markdown source. [`llms.txt`](/docs/llms.txt) indexes the pages for agents, and [`llms-full.txt`](/docs/llms-full.txt) contains all of them in one file.
