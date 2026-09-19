---
title: The Vectis app
description: What each part of the Mac app does, and where to find the CLI and MCP equivalents.
---

The app is a window onto the background service. Closing it leaves the service and its jobs running. Everything in the app is also available in the `vectis` CLI and to agents through `vectis-mcp`.

| View             | What it shows and does                                                                                                                                                                                              | CLI                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Overview**     | The service, running VMs, operations that need you and the operation history. Pause or resume new VMs, stop or reconcile VMs, cancel operations. The menu stops the service when idle or removes the login service. | `status`, `pause`, `resume`, `operation`   |
| **Environments** | Your guest images. Prepare Ubuntu, macOS or Windows, register an existing image, start a clean VM, and set default CPU, memory and VM folder.                                                                       | `environment`                              |
| **Repositories** | Connections on this Mac with their `runs-on` label, the **Automatic** switch, **Start runner**, recent jobs, workflow migration and disconnecting.                                                                  | `repository`, `runner`, `job`, `migration` |
| **Connections**  | Connect this Mac to your account, link GitHub, and sign in to control your other Macs.                                                                                                                              | `cloud`, `github`, `login`                 |
| **Storage**      | Disk usage of images and VMs, including blocks shared between copies.                                                                                                                                               | `storage`                                  |
| **Diagnostics**  | Host support, runtime components, the service log and the command line tools installer.                                                                                                                             | `doctor`, `logs`                           |

Keyboard: **Cmd+1** to **Cmd+6** switch views, **Cmd+B** toggles the sidebar.

## Control another Mac

After signing in under **Connections > Other Macs**, the machine switcher at the bottom of the sidebar selects which Mac the views control. File pickers work only for this Mac; for another Mac, type paths that exist on it. Service installation and pairing only work on the Mac itself. See [Remote control](/docs/guides/remote-control).

## Updates

The app updates itself from GitHub Releases and restarts the service only when it is idle. See [Updates](/docs/get-started/install#updates).
