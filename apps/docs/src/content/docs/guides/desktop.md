---
title: Development desktop
description: Control the local service from the Electron interface.
---

Build and open the desktop from a development checkout:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
pnpm desktop:start
```

The desktop uses the same local service and state as the CLI. Set `VECTIS_HOME` before starting it to select a separate state directory. The default is `~/.vectis`. Keep service state on the internal disk; macOS background-process access to removable volumes can prevent service startup. VM storage is configured separately for each environment.

The first screen can install and start the per-user background service. Closing Vectis leaves that service running. Stopping the service explicitly also stops its owned VMs. The development launcher supplies the standalone Node executable; the service does not depend on Electron staying open.

## Available controls

- Overview shows VM states and durable operations, with pause, resume, stop, and reconciliation controls. Pausing prevents new VMs and leaves running work alone.
- Environments registers prepared images and configures CPU count, memory, and VM storage. A native folder picker selects storage locations.
- Storage measures base images and individual VM files, including allocated host blocks. Shared APFS blocks can affect interpretation; guest filesystem categories are not available yet.
- Connections opens GitHub account linking and machine pairing in your browser. Pairing requires the configured Keychain helper and a running local service. Compare the verification code before approval, then finish pairing in Vectis.

A registered image is not automatically a verified GitHub runner. This interface is a development preview: guided OS installation, full remote controls, and release packaging are still being integrated. Use the [CLI reference](/docs/reference/cli/) to discover the currently supported headless controls.
