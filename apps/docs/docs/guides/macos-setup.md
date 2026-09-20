---
title: Install a macOS guest
description: Restore macOS into an owned local bundle and open its setup console.
---

Vectis downloads macOS 26.6.2 (build 25G83) directly from Apple and verifies its pinned SHA-256 and exact size before installation. The selected revision does not change when Apple publishes a new major release. You can instead supply an existing Apple macOS 26 IPSW. The Apple virtualization helper checks host and restore-image compatibility. Guest SSH enrollment uses a generated local connection script and explicit guest verification. Xcode is not installed implicitly.

Choose existing image and disposable VM directories. The image volume needs at least 60 GiB free for automatic download and installation, or 40 GiB with an existing IPSW. Stop existing VMs and resolve interrupted runner operations first. The installer uses a new bundle; it never replaces a registered base image.

```sh
vectis environment install-macos macos-26-arm64 \
  --image-directory /absolute/path/to/images \
  --storage-path /absolute/path/to/vms \
  --cpu 2 --memory-mib 4096 --disk-gib 64 --json
vectis operation wait <operation-id> --timeout 3600000 --json
```

For existing media, add `--restore-path /absolute/path/to/restore.ipsw`. In desktop **Environments > Prepare a guest image**, select **macOS 26 ARM64**. Leave the optional restore path empty to download, or choose an existing image. CLI, desktop and MCP all use the same durable service operation. Closing the desktop does not cancel installation.

A completed restore reports `action_required`, a `setupId` and the installed bundle path. This means the operating system is installed, not that a runner is ready.

```sh
vectis environment open-macos-setup <setup-id> --json
```

This opens the guest console on the host Mac. Create a local `vectis` account without Apple ID and enable guest Remote Login. Keep FileVault disabled inside this CI guest so fresh clones can boot unattended. This does not change host encryption. Close the console or cancel its operation to stop the guest. Reopening the same setup continues from its existing disk.

## Connect and verify the guest

Keep the setup console open with guest Remote Login enabled. Desktop offers **Connect guest SSH on host** beside the running setup operation. This opens a generated connection script in Terminal on the host. From the CLI:

```sh
vectis environment connect-macos-guest <setup-id> --open-terminal --json
```

Without `--open-terminal`, the operation returns the generated `scriptPath` for a human to open locally. Non-interactive agents can prepare enrollment without launching a password prompt. Remote control opens Terminal on the host, not on the controller machine.

The script uses a dedicated guest key and an isolated known-hosts file. Confirm the guest host-key fingerprint in Terminal, then enter only the guest `vectis` password there. To inspect the guest's fingerprint, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` inside the guest. The password is never sent to Vectis or the cloud. Do not disable host-key checking or supply a general-purpose host identity.

After the script finishes, choose **Verify guest SSH**, or run:

```sh
vectis environment verify-macos-guest <setup-id> --wait --json
```

Verification checks the pinned SSH connection, ARM64 architecture, clock synchronization, macOS 26, guest FileVault being off, and the guest's developer toolchain. Successful verification still returns `action_required`: shut down the guest from its Apple menu, then choose **Finish macOS setup**, or run:

```sh
vectis environment finish-macos-setup <setup-id> --wait --json
```

Vectis registers the environment only after the same verified setup session has stopped. Reopening its console requires another verification before finishing. A registered environment still needs repository linking and a real Actions verification job. Each runner checks guest readiness again before GitHub registration.

## What the guest contains

A macOS guest is whatever you install in its setup console. Vectis restores Apple's image, enrolls SSH and verifies the guest; it cannot install Xcode for you, because Apple does not permit redistributing it and it needs an Apple ID and tens of gigabytes.

One thing is not optional. Without a developer toolchain the guest has no working `git`, so `actions/checkout` fails on its first step and almost no workflow gets further. Verification refuses such a guest and tells you what to install. While the setup console is open, either run `xcode-select --install` for Apple's Command Line Tools, which bring `git`, `clang`, `make` and the macOS SDK, or install the full Xcode and open it once to accept its license. Jobs that build with Xcode, sign, or need a specific Xcode version need the full install, not the Command Line Tools.

Everything else follows the same rule as the other guests: `actions/setup-*` actions download toolchains at job time, and anything your jobs always need, such as Homebrew formulas or a specific Ruby, belongs in the guest before you register the environment, or in a workflow step.

## Interruption and recovery

```sh
vectis operation cancel <operation-id> --json
vectis environment resume-macos <setup-id> --json
```

Interrupted downloads retain their pinned source and partial bytes for the same setup. Completed download bytes are verified again before reuse. After a restore interruption, the service verifies the previous process has stopped. A completed restore is preserved. A failed restore retries into a new bundle and retains interrupted files for inspection; it does not overwrite uncertain disk state. Inspect the private `preparation.log` in the operation's image directory for errors.

A setup console is a local interactive operation. Remote callers can request it, but must use the host's screen to complete guest OS steps. No VNC or guest password is exposed through the cloud.

## Discard an unused setup

To permanently remove a stopped, unregistered setup, confirm its exact environment ID:

```sh
vectis environment discard-macos <setup-id> --environment <environment-id> --json
```

Desktop offers the same confirmation beside the setup operation. This deletes the current attempt's owned image directory, including its guest disk and setup logs. It preserves downloaded or supplied source IPSWs, registered environments, and older interrupted attempt directories. Active or registered setups and directories without matching ownership metadata cannot be discarded.
