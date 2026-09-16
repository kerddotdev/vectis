---
title: Portable development packages
description: Build and verify the standalone CLI, MCP server, and local service.
---

The portable macOS ARM64 development package includes its own pinned Node runtime, CLI, MCP server, background service, Apple virtualization helper, and Keychain helper. It runs outside the source checkout without Node or pnpm on the user's PATH.

The CLI payload is an ad-hoc-signed development artifact, not a notarized public release. An optional Windows runtime can include QEMU, qemu-img, swtpm, and their libraries. Firmware and guest operating system images remain separate. Do not disable Gatekeeper to distribute this artifact.

## Build

Build the native helpers and the TypeScript applications with the pinned project tools. Pass the directory containing both `vectis-vm` and `vectis-keychain`:

```sh
swift build --package-path native/apple --configuration release
pnpm package:cli --output /absolute/path/to/new-package --helpers /absolute/path/to/native-binaries
pnpm package:verify /absolute/path/to/new-package
```

The output directory must not already exist. The build downloads Node 24.21.0 from nodejs.org and checks its pinned SHA-256 and byte length. The Node license and dependency license files stay in the package. Package contents use an explicit allowlist; environment files and internal documents are excluded. An inspection rejects external dependency symlinks.

To stage the Windows runtime from locally built or installed binaries, provide the matching QEMU source tree and a new output directory:

```sh
pnpm package:windows-runtime --qemu /absolute/path/to/qemu-system-aarch64 --qemu-img /absolute/path/to/qemu-img --swtpm /absolute/path/to/swtpm --qemu-source /absolute/path/to/qemu-source --output /absolute/path/to/windows-runtime
pnpm package:cli --output /absolute/path/to/new-package --helpers /absolute/path/to/native-binaries --windows-runtime /absolute/path/to/windows-runtime
```

Staging copies the ARM64 binaries and non-system libraries, rewrites library references within the bundle, and records source hashes. It does not modify the original installations. This development bundle still requires complete corresponding sources and third-party license materials before redistribution; `BUILD.json` records that limitation.

`package:verify` runs isolated service start, pause, stop, restart, resume, MCP stdio, and cleanup checks using the packaged runtime with no Node on PATH. It preserves failed-test state if service shutdown cannot be verified. Run it after moving the package outside the checkout to check relocation too.

## Use

Keep the package directory intact and add its `bin` directory to PATH. Do not symlink individual launchers. Both launchers resolve the packaged runtime relative to themselves:

```sh
/absolute/path/to/package/bin/vectis --help
/absolute/path/to/package/bin/vectis service start --home /absolute/path/to/test-state --json
/absolute/path/to/package/bin/vectis-mcp --home /absolute/path/to/test-state
```

The launchers configure the packaged Apple and Keychain helpers and any bundled Windows runtime automatically. Explicit `VECTIS_APPLE_HELPER`, `VECTIS_KEYCHAIN_HELPER`, `VECTIS_QEMU`, `VECTIS_QEMU_IMG`, and `VECTIS_SWTPM` overrides remain available for development. Service installation records absolute paths, so stop and uninstall its login registration before moving or removing an installed package. Uninstalling that registration preserves images, configuration, and credentials.

The package does not grant GitHub access or connect a cloud account automatically. Follow the [local setup guide](/docs/guides/local-setup/) and [remote control guide](/docs/guides/remote-control/).

## Desktop development app

Build the renderer before creating a fresh portable payload, then wrap it with the pinned Electron version:

```sh
pnpm desktop:build
pnpm package:cli --output /absolute/path/to/new-payload --helpers /absolute/path/to/native-binaries
pnpm package:desktop --package /absolute/path/to/new-payload --output /absolute/path/to/new-desktop-output
```

The result is `Vectis Dev-darwin-arm64/Vectis Dev.app`. The app finds its Node runtime and native helpers inside its own Resources directory. Installing the service from the desktop registers that independent runtime with macOS; closing the desktop leaves it running.

The default desktop build is for local development verification. Add `--sign` to use an available Developer ID Application identity. Add `--keychain-profile <profile-name>` together with `--sign` to submit the signed app for notarization using an existing notarytool profile. Signing errors fail the build; signing alone does not mean Apple has notarized the app.

Keep the app at its installed location while its login service is registered. The portable payload and app contain their own copies of the runtime, so the payload can be removed after packaging if no service uses it.

macOS file privacy permissions also apply to the signed background service. A successful CLI test from a terminal does not establish that the login service can access the same images or storage directory. Verify that access separately before relying on unattended VM startup.
