# Apple Silicon QEMU runtime

Vectis runs QEMU as a separate process with explicit HVF acceleration. Windows instances get their own writable UEFI variables, TPM state, and QCOW2 overlay. Install `swtpm` separately and configure `VECTIS_SWTPM`, `VECTIS_QEMU`, and `VECTIS_QEMU_IMG` with absolute executable paths.

## TPM compatibility patch

QEMU 11.1.1 registers the ARM TPM physical presence interface (PPI) memory region with a size smaller than the Apple Silicon host page. HVF rejects this mapping with `HV_BAD_ARGUMENT`. The included patch aligns the registered region to the same host page size already used for its allocation. It keeps PPI enabled and does not enable software emulation.

Source: [QEMU 11.1.1](https://download.qemu.org/qemu-11.1.1.tar.xz).

SHA-256: `079ffbff8a7111bbc89022107cbabf3bbfd614d5fc9d7cc675991196aca12482`.

Build in an isolated working directory, without replacing the system QEMU:

```sh
curl --fail --location --output qemu-11.1.1.tar.xz https://download.qemu.org/qemu-11.1.1.tar.xz
echo '079ffbff8a7111bbc89022107cbabf3bbfd614d5fc9d7cc675991196aca12482  qemu-11.1.1.tar.xz' | shasum -a 256 -c -
tar --exclude='*/EmulatorPkg/Unix/Host/X11IncludeHack' -xf qemu-11.1.1.tar.xz
patch -d qemu-11.1.1 -p1 < /absolute/path/to/vectis/native/qemu/patches/0001-align-arm-tpm-ppi-to-host-page.patch
mkdir build
cd build
../qemu-11.1.1/configure --target-list=aarch64-softmmu --enable-hvf --disable-tcg --disable-pvg --disable-docs --disable-werror --disable-tools --disable-guest-agent --disable-sdl --disable-gtk --disable-cocoa --enable-slirp --datadir=/opt/homebrew/share/qemu
ninja -j6 qemu-system-aarch64
```

The build needs Xcode command-line tools, Python, Ninja, GLib, pixman and libslirp. The data directory above uses the matching Homebrew QEMU firmware. The excluded archive entry is an absolute symlink for the unused EDK2 X11 emulator. Disabling PVG avoids an unrelated removed graphics API in the macOS 27 SDK; this runtime is headless. QEMU's build applies the local hypervisor entitlement. This is a development build, not a notarized release artifact.

The patched binary passed a two-instance ARM64 UEFI test with HVF, PPI enabled, independent TPM processes, private firmware variables, a custom storage path containing a comma, and isolated shutdown and cleanup. This does not establish Windows guest installation, driver compatibility, or a GitHub Actions job.

## Distribution

No QEMU or firmware binaries are committed here. QEMU is GPL v2 software with component-specific licenses; see the exact source archive's `COPYING` and `LICENSE` files and [upstream licensing documentation](https://www.qemu.org/docs/master/about/license.html). A binary distribution must include corresponding source with this patch and the applicable license materials, including separately supplied firmware and TPM components. The patch is provided under GPL-2.0-or-later, matching the modified source file.
