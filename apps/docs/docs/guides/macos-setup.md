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

## Network access

Apple Virtualization NAT does not enforce egress filtering. The guest can reach the internet, the host and the local network. Status reports `network: { egress: "open", enforcement: "not_enforced" }`, including for existing environments without an explicit setting.

`vectis environment configure <id> --egress open --json` is accepted. Requesting `internet_only` fails with `egress_unsupported`: "Apple Virtualization NAT cannot restrict guest network access yet; this environment can reach the host and local network." Windows environments support enforced internet-only egress. Inspect effective state with `vectis status --json`, `vectis environment list --json` or MCP `vectis_status`; MCP uses the same configuration command.

## What the guest contains

A macOS guest is whatever you install in its setup console. Vectis restores Apple's image, enrolls SSH and verifies the guest; it cannot install Xcode for you, because Apple does not permit redistributing it and it needs an Apple ID and tens of gigabytes.

One thing is not optional. Without a developer toolchain the guest has no working `git`, so `actions/checkout` fails on its first step and almost no workflow gets further. Verification refuses such a guest and tells you what to install. While the setup console is open, either run `xcode-select --install` for Apple's Command Line Tools, which bring `git`, `clang`, `make` and the macOS SDK, or install the full Xcode and open it once to accept its license. Jobs that build with Xcode, sign, or need a specific Xcode version need the full install, not the Command Line Tools.

Everything else follows the same rule as the other guests: `actions/setup-*` actions download toolchains at job time, and anything your jobs always need, such as Homebrew formulas or a specific Ruby, can be installed once into a [derived environment](/docs/guides/environments) with `environment.provision`, or installed in a workflow step.

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

## Provision an existing guest

Use [environment provisioning](/docs/guides/environments) to create a new `base.bundle` from a ready macOS environment. The runner is installed without sudo under `$HOME/.vectis-runner/<version>`, and optional setup scripts run as the SSH user with Bash. Provisioning does not install Xcode or change the parent bundle.

Provisioning uses this bounded shutdown sequence instead of the virtual power button, which can open a confirmation dialog in a logged-in macOS session:

1. Over SSH as the guest user, run `osascript -e 'tell application "loginwindow" to «event aevtshut»'`, then wait up to 60 seconds for the VM to stop. Apple's SDK identifies `shut` as `kAEShutDown`; `rsdn` is `kAEShowShutdownDialog` and would request confirmation. The command does not invoke sudo. [Apple documents the loginwindow shutdown event](https://developer.apple.com/library/archive/qa/qa1134/_index.html), but whether macOS 26 accepts it from the SSH session without Automation/TCC consent has not been verified. Guest applications can also cancel shutdown.
2. If the VM is still running and `sudo -n true` succeeds, run `sudo -n /sbin/shutdown -h now` and wait up to another 60 seconds. SSH enrollment does not grant passwordless sudo, and provisioning never prompts for a password.
3. If the guest remains running, complete two separate `sync` commands over SSH, wait 5 seconds, then force-stop the owned provisioning VM through the Apple helper. Each SSH command and helper stop has a 30-second limit. A failed or timed-out sync prevents image registration; failed or cancelled provisioning removes its partial output after confirmed VM cleanup. Unconfirmed cleanup requires inspection.

The final operation result reports `shutdown` as `loginwindow`, `sudo`, or `forced_stop_after_sync`. The last value explicitly means the image was frozen after a forced stop following two successful syncs, not after an observed clean guest shutdown. This fallback applies only to the derived provisioning image, never ordinary runner VMs or user data. Inspect it with `vectis operation get <operation-id> --json`.
