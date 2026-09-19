---
title: Package and sign
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

Collect the pinned sources and verify them against the runtime you intend to package:

```sh
pnpm package:runtime-sources --runtime /absolute/path/to/windows-runtime --output /absolute/path/to/source-materials
pnpm package:verify-runtime-sources --runtime /absolute/path/to/windows-runtime --sources /absolute/path/to/source-materials
```

Verification checks component versions, source and upstream patch coverage against the runtime's bundled SPDX records, archive checksums and sizes, notice and recipe files, and the custom QEMU patch. Missing or mismatched materials fail verification. The DMG packager performs the same verification on its staged copies before creating the image. This checks technical completeness and integrity; it does not grant a license or certify legal compliance.

`package:verify` runs isolated service start, pause, stop, restart, resume, MCP stdio, and cleanup checks using the packaged runtime with no Node on PATH. It preserves failed-test state if service shutdown cannot be verified. Run it after moving the package outside the checkout to check relocation too.

## Use

Keep the package directory intact and add its `bin` directory to PATH. Do not symlink individual launchers. Both launchers resolve the packaged runtime relative to themselves:

```sh
/absolute/path/to/package/bin/vectis --help
/absolute/path/to/package/bin/vectis service start --home /absolute/path/to/test-state --json
/absolute/path/to/package/bin/vectis-mcp --home /absolute/path/to/test-state
```

The launchers configure the packaged Apple and Keychain helpers and any bundled Windows runtime automatically. Explicit `VECTIS_APPLE_HELPER`, `VECTIS_KEYCHAIN_HELPER`, `VECTIS_QEMU`, `VECTIS_QEMU_IMG`, and `VECTIS_SWTPM` overrides remain available for development. Service installation records absolute paths, so stop and uninstall its login registration before moving or removing an installed package. Uninstalling that registration preserves images, configuration, and credentials.

The package does not grant GitHub access or connect a cloud account automatically. Follow the [quickstart](/docs/get-started/quickstart) and the [remote control guide](/docs/guides/remote-control).

## Desktop development app

Building desktop or headless app bundles requires Xcode 26 or later for the Icon Composer source in `assets/brand/vectis.icon`. Packaging compiles both the modern asset catalog and a macOS 15 `.icns` fallback. The web mark and reusable palette live beside it under `assets/brand/web`.

Build the renderer before creating a fresh portable payload, then wrap it with the pinned Electron version:

```sh
pnpm desktop:build
pnpm package:cli --output /absolute/path/to/new-payload --helpers /absolute/path/to/native-binaries
pnpm package:desktop --package /absolute/path/to/new-payload --output /absolute/path/to/new-desktop-output
```

The result is `Vectis-darwin-arm64/Vectis.app` for a production payload (`pnpm package:cli --flavor production`) or `Vectis Dev-darwin-arm64/Vectis Dev.app` for a development one. The app also contains the `vectis` and `vectis-mcp` launchers in `Contents/Resources/bin`. The app finds its Node runtime and native helpers inside its own Resources directory. Installing the service from the desktop registers that independent runtime with macOS; closing the desktop leaves it running.

The default desktop build is for local development verification. Add `--sign` to use an available Developer ID Application identity. Add `--keychain-profile <profile-name>` together with `--sign` to submit the signed app for notarization using an existing notarytool profile. Signing errors fail the build; signing alone does not mean Apple has notarized the app.

For a team App Store Connect API key, use `--sign --notarize` with `APPLE_API_KEY` (an absolute `.p8` file path), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` in the process environment. A supplied Keychain profile takes precedence. Merely setting these variables does not enable notarization. Keep the key outside the source checkout and package payload; never commit it or pass its contents as a command argument.

Keep the app at its installed location while its login service is registered. The portable payload and app contain their own copies of the runtime, so the payload can be removed after packaging if no service uses it.

macOS file privacy permissions also apply to the signed background service. A successful CLI test from a terminal does not establish that the login service can access the same images or storage directory. Verify that access separately before relying on unattended VM startup.

## Electron-free signed runtime

The standalone runtime can also be packaged as a native macOS application bundle without Electron. Build the small launcher, then wrap a portable payload:

```sh
swift build --package-path native/apple --configuration release --product vectis-launcher
pnpm package:headless --package /absolute/path/to/payload --launcher /absolute/path/to/vectis-launcher --output /absolute/path/to/new-runtime --identity YOUR_DEVELOPER_ID_IDENTITY
pnpm package:verify /absolute/path/to/new-runtime
```

The output contains `Vectis Runtime.app` and `bin/vectis` and `bin/vectis-mcp`. Keep them together. Without `--identity`, this is an ad-hoc development build. Signing alone does not notarize the bundle. Add `--notarize` with the same API key environment variables described above, or `--keychain-profile <profile>` with `--identity`. The packager submits to Apple, requires acceptance, staples and validates the ticket, and checks Gatekeeper before recording notarization success. Third-party redistribution requirements still apply to any included Windows runtime.

## Replace an installed runtime

Keep the previous package at its original location. Run the new package's CLI against the existing state directory:

```sh
/absolute/path/to/new-package/bin/vectis service update --home /absolute/path/to/state --json
```

This validates the new runtime paths, refuses active work, waits for the old service to stop, and replaces its login registration. The new service must respond before the update succeeds. If startup fails, Vectis attempts to restore and start the previous registration. VM images, credentials, and configuration stay in the same locations.

After an interrupted update, use `service recover-update` with the same home. The saved previous registration remains available until recovery succeeds. Other registration changes are blocked while recovery is pending, and concurrent clients cannot replace the registration simultaneously. Keep both packages until the operation completes.

The desktop's **Use this app's runtime** and **Recover runtime update** buttons use the same operations. MCP exposes `vectis_service` with `action: "update"` or `action: "recoverUpdate"`. Updates adopt the runtime running that client; they do not download a release. This recovery restores the runtime registration, not a backup of application data or a general database downgrade.

## Release artifacts

Create the release artifacts from an already notarized desktop app. Include the matching collected runtime sources when Windows binaries are bundled:

```sh
pnpm package:release --app /absolute/path/to/Vectis.app --output /absolute/path/to/new-directory --identity YOUR_DEVELOPER_ID_IDENTITY
```

Use the API key environment variables above or `--keychain-profile`. The command verifies the app signature and stapled ticket, then writes:

- `Vectis-arm64.dmg`: the app with an Applications shortcut, signed and notarized. Development builds produce `Vectis-Dev-arm64.dmg`.
- `Vectis-<version>-arm64-mac.zip` and `latest-mac.yml`: the update payload and feed that installed production apps read from GitHub Releases. Development builds have no update feed.

It does not publish anything. Production apps look for updates on the `kerddotdev/vectis` GitHub Releases, so a fork must change `scripts/release/desktop-identity.ts`.

Drag the app to Applications before opening it and installing the service. Do not install the background service directly from a mounted disk image.
