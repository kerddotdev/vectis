---
title: Install Vectis
description: Requirements, installation, the background service and the command line tools.
---

## Requirements

- A Mac with Apple Silicon, running macOS 15 or later. Intel Macs are not supported.
- Free disk space for the guests you prepare, on the internal disk or an external drive:

| Guest                     | Free space to prepare                         | Notes                                                      |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Ubuntu 24.04              | 8 GiB or more                                 | Grows as software is installed                             |
| macOS 26                  | 60 GiB, or 40 GiB with your own restore image | Apple's restore image is downloaded unless you provide one |
| Windows 11 (experimental) | 30 GiB or more                                | Needs your own installation media and QEMU                 |

- Every running VM also needs space for its copy of the disk. Copies share unchanged blocks with the image, so they start small.
- A VM may use at most 75% of the Mac's memory, so macOS always keeps room for itself.

## Install the app

1. Download [Vectis for macOS](https://github.com/kerddotdev/vectis/releases/latest/download/Vectis-arm64.dmg).
2. Open the disk image and drag **Vectis** to **Applications**. Open it from there, not from the disk image.
3. Choose **Install and start service** on the first screen. This registers the Vectis background service for your user, so it runs after you close the window and after you log in again.

macOS may ask you to allow Vectis in **System Settings > General > Login Items & Extensions**. If you keep images or VMs on an external drive, macOS also asks whether Vectis may access that volume; allow it, or VMs on that drive cannot start.

Vectis keeps its state in `~/.vectis`: the database, the service log and the local connection details. VM images and disks live in the folders you choose for each environment.

## Command line tools

The app contains the `vectis` CLI and the `vectis-mcp` server for agents. In the app, open **Diagnostics** and choose **Install** under **Command line tools**. This places two small launchers in `~/.local/bin` that run the tools inside the app, so they always match the installed version.

If `~/.local/bin` is not on your PATH, the app tells you. Add this line to `~/.zshrc`, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Check the installation:

```sh
vectis --version
vectis status --json
```

## Updates

The app checks for new releases in the background and downloads them. When an update is ready, **Restart to update** appears in the sidebar. Vectis installs it only when no VM or operation is running: it stops the idle service, installs the update and starts the service again. While jobs are running, the sidebar says the update will install when they finish. The CLI and MCP server update with the app.

## Uninstall

1. In the app, open **Overview**, choose **Stop service if idle**, then **Remove login service** from the same menu. Or run `vectis service stop --if-idle` and `vectis service uninstall`.
2. Delete Vectis from Applications, and `~/.local/bin/vectis` and `~/.local/bin/vectis-mcp` if you installed them.
3. To remove all data, delete `~/.vectis` and the image and VM folders you chose. The Mac stays listed under **Macs** at [vectis.kerd.dev/connect](https://vectis.kerd.dev/connect) as offline and receives no more jobs.

Remove the login service before deleting the app; otherwise macOS keeps trying to start a service that no longer exists.
