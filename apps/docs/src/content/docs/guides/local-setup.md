---
title: Local setup
description: Build the headless tools and run an isolated local service.
---

Use Node.js 24.21 or newer within the Node 24 release line, and pnpm 10.24.0. Native VM execution requires an Apple Silicon Mac. This development checkout does not provide a signed installer yet.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vectis service start --home /tmp/vectis-demo --json
pnpm vectis status --home /tmp/vectis-demo --json
pnpm vectis doctor --home /tmp/vectis-demo --json
```

Keep using the same `--home` for a given service. It contains the SQLite database, service log, and authenticated local connection metadata. It is separate from your chosen VM storage directory. Do not share `connection.json`; it contains a local access token.

The service runs independently of the CLI. Stop it with:

```sh
pnpm vectis service stop --home /tmp/vectis-demo --json
```

## Start at login on macOS

After building the checkout, install a per-user login service:

```sh
pnpm vectis service install --home /absolute/path/to/vectis-state --json
pnpm vectis service status --home /absolute/path/to/vectis-state --json
```

Stop an already running manual service before installation. Installation registers a LaunchAgent for the current macOS user and waits for an authenticated response before reporting that it is running. macOS may require background item approval in System Settings. A registration whose startup times out remains available for inspection, retry, or removal.

The registration stores absolute paths to Node, this built checkout, the state directory, and any configured `VECTIS_APPLE_HELPER`, `VECTIS_QEMU`, `VECTIS_QEMU_IMG`, `VECTIS_SWTPM`, and `VECTIS_KEYCHAIN_HELPER` executables. Set these before installation. Other shell variables and secrets are not copied. Keep the checkout and runtime paths available; this is not yet a standalone installer. To change runtime paths, stop, uninstall, and install again with the new values.

An abnormal exit permits launchd to restart the service. An authenticated `service stop` exits cleanly and leaves it stopped until `service start` or the next login. Logging out ends this per-user service. Closing the terminal does not. This behavior follows Apple's [LaunchAgent lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

Remove the login registration after stopping the service:

```sh
pnpm vectis service stop --home /absolute/path/to/vectis-state --json
pnpm vectis service uninstall --home /absolute/path/to/vectis-state --json
```

Stopping the service stops its owned VMs. Uninstalling the registration preserves state, images, and chosen VM storage. `service status` reports registration and launchd loading; use `status` for the live machine and operations. The MCP `vectis_service` tool exposes the same login-service controls and can discover registration without a running local API.

## Prepared Linux images

For development, the Apple helper can start a prepared, bootable ARM64 Linux raw disk with EFI. A raw filesystem partition alone is not a bootable VM disk. Build the helper with Xcode's Swift tools, then sign the development binary with its virtualization entitlement:

```sh
swift build --package-path native/apple
codesign --force --sign - --entitlements native/apple/entitlements.plist native/apple/.build/out/Products/Debug/vectis-vm
```

Set `VECTIS_APPLE_HELPER` to the absolute executable path before starting the service. A previously running service must be restarted to pick up runtime configuration. Use `environment register --file environment.json` to register the prepared image. See the [storage guide](/docs/guides/storage/) for the file format.

Registering an environment does not install tools or a GitHub runner in it. Current command execution evidence comes from the Ubuntu cloud-init proof script, not a finished interactive guest management interface.

## Operation outcomes

Mutating commands return an operation ID. `accepted` means the request was recorded. Use `--wait` or `operation wait <id>` to observe completion. Exit code `1` indicates failure; `3` indicates `action_required`.

`pause` prevents new VM starts and leaves running work alone. `instance stop <id>` stops a VM owned by the service. After a service crash, an interrupted instance requires verified process-exit evidence before Vectis removes its working directory.

## Connect your machine

The development pairing flow requires the native Keychain helper. Set `VECTIS_KEYCHAIN_HELPER` to its absolute executable path before starting both the service and CLI. An installed login service captures this path at installation.

```sh
pnpm vectis cloud pair --home /absolute/path/to/vectis-state --json
```

Open the returned `https://vectis.kerd.dev/connect` link yourself. Compare the verification code with the CLI output, sign in, and approve the machine. Treat the pairing link as private and never approve a link supplied by someone else. The request expires after ten minutes. The default backend is the dedicated Vectis development deployment; `--url` selects another deployment for a separately configured web frontend.

Then finish the connection:

```sh
pnpm vectis cloud finish --home /absolute/path/to/vectis-state --json
pnpm vectis status --home /absolute/path/to/vectis-state --json
```

`pending` means browser approval has not completed. `linked` means the credential and local configuration were saved; inspect the separate `cloud.state` to confirm the relay is connected. Finishing pairing reloads the cloud connection without restarting the service or stopping VMs. Retries reuse the pending credential or verify the saved connection. Pairing does not silently replace an existing machine connection.

The service and CLI keep raw credentials in macOS Keychain. The web approval contains only credential fingerprints. An MCP process configured with the same Keychain helper exposes `vectis_cloud` for the same pair and finish actions. Human approval is always explicit.

This connects a machine to Vectis. GitHub App installation and official Actions runner provisioning are separate steps that are not yet available through this setup flow.
