---
title: Vectis
description: Local virtual machines for GitHub Actions, controlled by people and agents.
---

Vectis runs disposable virtual machines on your own Apple Silicon Mac. The local service owns each VM and its files. The CLI, desktop, and agent interfaces are designed to use the same control contract.

**This is a development build.** The CLI and MCP can control prepared environments, inspect storage, and preview workflow migrations. Guided OS installation, GitHub App pairing, actual Actions jobs, and the desktop interface are not available yet. Do not treat a registered image as a verified runner.

Start with [local setup](/guides/local-setup/), then choose [VM storage and resources](/guides/storage/). Agents can use the [integration guide](/guides/agents/) and generated [CLI reference](/reference/cli/).

The intended guest systems are Ubuntu ARM64, macOS, and Windows ARM64. Ubuntu VM boot and clean-instance reuse have been demonstrated. macOS and Windows guest preparation remain under development.

The central service coordinates identity and remote commands. VM disks and build files stay on the host. Normal GitHub Actions logs, artifacts, and caches still follow GitHub's behavior.

## Read without a browser

The same documentation is available as Markdown under `/markdown/`. [`llms.txt`](/llms.txt) indexes these files for agents.
