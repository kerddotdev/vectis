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

The service runs independently of the CLI. `service start` does not yet install a login item. Stop it with:

```sh
pnpm vectis service stop --home /tmp/vectis-demo --json
```

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
