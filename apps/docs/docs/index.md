---
title: Vectis
description: GitHub Actions runners in disposable VMs on your own Mac, for people and agents.
---

Vectis runs every GitHub Actions job in a fresh virtual machine on your Apple Silicon Mac and deletes it when the job ends. You prepare an Ubuntu, macOS or Windows guest once; each job gets a clean copy.

Three parts work together:

- **The Vectis app and its background service** run on your Mac. The service owns the VMs, the disks and the local credentials. The app, the `vectis` CLI and the `vectis-mcp` server for agents are all clients of the same service.
- **Your account at [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect)** links your Macs, your GitHub accounts and your repositories. It also relays commands when you control one Mac from another.
- **The Vectis GitHub App** lets Vectis see queued jobs for the repositories you connect and register a single-use runner for each one.

Build files and VM disks never leave your Mac. The only cloud traffic is coordination: which jobs are waiting, which Mac takes them, and what happened.

## Start here

1. [Install Vectis](/docs/get-started/install) and check the requirements.
2. Follow the [quickstart](/docs/get-started/quickstart) from an empty Mac to your first job.
3. Point your workflows at Vectis with the right [runs-on label](/docs/guides/repositories#choose-the-runs-on-label).

## For agents

Agents use the same tools as you. See [Agents](/docs/guides/agents) to install the skill and connect the MCP server. Append `.md` to any page URL to read its Markdown source; [`llms.txt`](/docs/llms.txt) indexes every page and [`llms-full.txt`](/docs/llms-full.txt) contains all of them.

## Run it yourself

Vectis is open source. [Self-hosting](/docs/self-hosting/cloud) explains how to build it from source and run your own backend, website and GitHub App.
