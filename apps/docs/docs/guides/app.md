---
title: The Vectis app
description: What each part of the Mac app does, and where to find the CLI and MCP equivalents.
---

The app is a window onto the background service. Closing it leaves the service and its jobs running. Everything in the app is also available in the `vectis` CLI and to agents through `vectis-mcp`.

| View             | What it shows and does                                                                                                                                                              | CLI                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Overview**     | The service, recent VMs, what needs you and the latest activity. Pause or resume new VMs, stop or reconcile VMs. The menu stops the service when idle or removes the login service. | `status`, `pause`, `resume`                |
| **Activity**     | Everything this Mac was asked to do, grouped by day or repository, with search and filters. Open one to see its steps, dismiss it, or stop the work it owns.                        | `activity`, `operation`                    |
| **Environments** | Your guest images. Prepare Ubuntu, macOS or Windows, register an existing image, start a clean VM, and set default CPU, memory and VM folder.                                       | `environment`                              |
| **Repositories** | Your repositories, each with the environments it runs on, their `runs-on` label, the **Automatic** switch, **Start runner**, recent jobs, workflow migration and disconnecting.     | `repository`, `runner`, `job`, `migration` |
| **Connections**  | Connect this Mac to your account, link GitHub, and sign in to control your other Macs.                                                                                              | `cloud`, `github`, `login`                 |
| **Storage**      | Disk usage of images and VMs, including blocks shared between copies.                                                                                                               | `storage`                                  |
| **Diagnostics**  | Host support, runtime components, the service log and the command line tools installer.                                                                                             | `doctor`, `logs`                           |

Keyboard: **Cmd+1** to **Cmd+7** switch views, **Cmd+B** toggles the sidebar.

## Activities and their steps

An activity is one thing you or GitHub asked for: preparing an environment, running a job, connecting a repository. The operations underneath it are the steps that carried it out, and you see them as **Steps** when you open an activity. Preparing macOS, for example, is one activity whose steps are the installation, the setup console, the guest SSH enrollment and its verification.

An activity's status is the status of the work Vectis did. For a job, the GitHub result is a separate badge: a runner can finish cleanly while the job it ran fails, and both facts are shown.

## What the app tells you

Every view follows the service by itself: a change you make anywhere, and a change GitHub reports, appear without refreshing or switching views.

A setting that applies immediately, such as the **Automatic** switch, is confirmed by a notification once the service has applied it. Work that takes longer, such as preparing an image or running a job, is confirmed as started and then continues in **Activity**. Notifications about something that worked disappear on their own; a failure, or anything waiting for you, stays until you dismiss it.

## Control another Mac

After signing in under **Connections > Other Macs**, the machine switcher at the bottom of the sidebar selects which Mac the views control. File pickers work only for this Mac; for another Mac, type paths that exist on it. Service installation and pairing only work on the Mac itself. See [Remote control](/docs/guides/remote-control).

## Updates

The app updates itself from GitHub Releases and restarts the service only when it is idle. See [Updates](/docs/get-started/install#updates).
