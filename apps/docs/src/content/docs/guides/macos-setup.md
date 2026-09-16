---
title: Install a macOS guest
description: Restore macOS into an owned local bundle and open its setup console.
---

Vectis can install an existing Apple macOS 26 IPSW on an Apple Silicon host. The Apple virtualization helper validates host and restore-image compatibility. Automatic restore-image discovery and guest SSH enrollment are still being integrated. Xcode is not installed implicitly.

Choose existing image and disposable VM directories. The image volume needs at least 40 GiB free. Stop existing VMs and resolve interrupted runner operations first. The installer uses a new bundle; it never replaces a registered base image.

```sh
vectis environment install-macos macos-26-arm64 \
  --restore-path /absolute/path/to/restore.ipsw \
  --image-directory /absolute/path/to/images \
  --storage-path /absolute/path/to/vms \
  --cpu 2 --memory-mib 4096 --disk-gib 64 --json
vectis operation wait <operation-id> --timeout 3600000 --json
```

In desktop **Environments > Prepare a guest image**, select **macOS 26 ARM64** and choose the restore image. CLI, desktop and MCP all use the same durable service operation. Closing the desktop does not cancel installation.

A completed restore reports `action_required`, a `setupId` and the installed bundle path. This means the operating system is installed, not that a runner is ready.

```sh
vectis environment open-macos-setup <setup-id> --json
```

This opens the guest console on the host Mac. Create a local `vectis` account without Apple ID and enable guest Remote Login. Keep FileVault disabled inside this CI guest so fresh clones can boot unattended. This does not change host encryption. Close the console or cancel its operation to stop the guest. Reopening the same setup continues from its existing disk.

Guest-only SSH enrollment and host-key verification currently require manual configuration. Register the resulting bundle with the guest username, private-key path and pinned `known_hosts` file through the desktop prepared-image form or `environment register --file`. The host-key alias must match the environment ID. Never disable host-key verification or provide a general-purpose host identity. Each runner checks guest architecture, time and SSH readiness before registration with GitHub.

## Interruption and recovery

```sh
vectis operation cancel <operation-id> --json
vectis environment resume-macos <setup-id> --json
```

After interruption, the service verifies the previous process has stopped. A completed restore is preserved. A failed restore retries into a new bundle and retains interrupted files for inspection; it does not overwrite uncertain disk state. Inspect the private `preparation.log` in the operation's image directory for errors.

A setup console is a local interactive operation. Remote callers can request it, but must use the host's screen to complete guest OS steps. No VNC or guest password is exposed through the cloud.

## Discard an unused setup

To permanently remove a stopped, unregistered setup, confirm its exact environment ID:

```sh
vectis environment discard-macos <setup-id> --environment <environment-id> --json
```

Desktop offers the same confirmation beside the setup operation. This deletes the current attempt's owned image directory, including its guest disk and setup logs. It preserves the source IPSW, registered environments, and older interrupted attempt directories. Active or registered setups and directories without matching ownership metadata cannot be discarded.
