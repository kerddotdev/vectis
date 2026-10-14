---
title: Install a Windows guest
description: Prepare a local Windows 11 ARM64 image with private setup credentials and pinned SSH access.
---

Windows support is **experimental**. It installs Windows 11 ARM64 from your own ISO with QEMU and Apple's Hypervisor framework, and it does not fall back to slow CPU emulation. The Vectis app does not include QEMU, the software TPM or UEFI firmware; you install them yourself as described below.

## Prerequisites

Vectis needs four programs and two firmware files:

- **QEMU 11.1.1 with the Vectis TPM patch.** Stock QEMU cannot map the Windows TPM on Apple Silicon. Build it by following [the QEMU build notes](https://github.com/kerddotdev/vectis/blob/main/native/qemu/README.md); `qemu-img` comes from the same build or from Homebrew (`brew install qemu`).
- **swtpm**, the software TPM: `brew install swtpm`.
- **ARM64 UEFI firmware with Secure Boot support** and a blank **raw** variable-store template that matches it. The QEMU build notes name a pinned source and explain how to convert a QCOW2 template to raw. Do not reuse another VM's variable store or TPM state.
- **The VirtIO driver ISO** for ARM64 Windows, from the [virtio-win project](https://github.com/virtio-win/virtio-win-pkg-scripts).
- **A Windows 11 ARM64 ISO** from Microsoft, in English.

The service records runtime paths when it is registered. While no VM is running, register it again with the paths set:

```sh
export VECTIS_QEMU=/absolute/path/to/qemu-system-aarch64
export VECTIS_QEMU_IMG=/absolute/path/to/qemu-img
export VECTIS_SWTPM=/absolute/path/to/swtpm
vectis service update
```

**Diagnostics** in the app shows whether the service found them.

Choose existing directories for the base image and disposable VMs. Preparation requires an idle host, at least 30 GiB of free image storage, at least 2 CPU cores, 4096 MiB of guest memory and a virtual disk of at least 64 GiB. CPU and memory allocations must fit the host's limits. A thin virtual disk grows as Windows writes to it.

Use installation media you obtained from trusted publishers. Vectis fingerprints these local files and rejects changed media on resume; a local fingerprint does not establish publisher authenticity. The current unattended recipe targets English installation media and the selected Windows image name, normally `Windows 11 Pro`.

You must accept the applicable Windows license terms. Vectis does not provide a Windows license, activate Windows or bypass activation requirements.

## Start installation

In the app, open **Environments > Add environment**, select **Windows 11** and provide the media paths and resource limits. The equivalent CLI command is:

```sh
vectis environment install-windows windows-11-arm64 \
  --iso-path /absolute/path/to/windows-arm64.iso \
  --drivers-path /absolute/path/to/virtio-win.iso \
  --firmware-path /absolute/path/to/uefi-code.fd \
  --firmware-vars-path /absolute/path/to/blank-uefi-vars.fd \
  --image-directory /absolute/path/to/images \
  --storage-path /absolute/path/to/vms \
  --cpu 4 --memory-mib 8192 --disk-gib 96 \
  --image-name 'Windows 11 Pro' --accept-license --json
vectis operation wait <operation-id> --timeout 3600000 --json
```

The service creates a dedicated disk, UEFI variables, TPM state and setup identity. The local administrator password is generated into macOS Keychain. Temporary answer files and setup media contain guest credentials and are private local files: do not share them or upload them in diagnostics.

The recipe creates a local `vectis` account, disables automatic login after bootstrap, installs OpenSSH Server, restricts guest SSH to the QEMU host address and uses dedicated pinned keys. It does not share host directories or credentials with the guest. Windows setup and OpenSSH installation can require internet access.

The service reports success only after checking guest ARM64 architecture, clock synchronization and the setup marker over SSH, then observing a completed guest shutdown. It removes temporary setup media after completion. A successful setup registers the base environment; connecting a repository and observing its first Actions job are separate steps.

## What the guest contains

The recipe is designed to install Windows unattended. Preparation installs one thing a workflow cannot do without: Git. It downloads the pinned MinGit ARM64 build published by Git for Windows, the same portable build GitHub's own runner images use, verifies its SHA-256, unpacks it into `C:\Program Files\MinGit` and puts it on the machine `Path`. MinGit's configuration includes the standard `C:\Program Files\Git` configuration, so installing MinGit there would create a circular include. Without Git, `actions/checkout` cannot check out the repository. The installed version is recorded in the guest at `C:\ProgramData\Vectis\toolchain.json` together with the Windows build.

The download uses basic parsing to avoid the [Windows PowerShell 5.1 web-content confirmation prompt](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest?view=powershell-5.1). It still verifies the pinned SHA-256 before extracting Git.

Everything else comes from the workflow. Windows 11 provides PowerShell, `curl` and `tar`; `actions/setup-*` actions download their own toolchains at job time; build tools, SDKs and package managers are a job's own step. Nothing a job installs survives it, because every VM starts from the same base image.

## Interruption and recovery

```sh
vectis operation cancel <operation-id> --json
vectis environment resume-windows <setup-id> --json
```

Closing the desktop does not cancel the service operation. Cancellation preserves the owned disk for diagnosis and resume. The previous VM must have a matching exit receipt before another attempt is admitted. An uncertain process state blocks new VM starts.

An interrupted operation reports `action_required` with the setup ID and private directory. Its `setup.ppm` screenshot and `preparation.log` can help diagnose guest setup failures. The preparation log contains host runtime output, not the guest PowerShell error. The bootstrap records its failing stage, error message and script line in `C:\ProgramData\Vectis\diagnostic.json`. When SSH remains reachable, Vectis saves a bounded copy as `bootstrap-diagnostic.json` in the private setup directory before stopping the VM. Only the known stage appears in the operation message; the detailed error stays local. Older setup media may have only the generic failure marker. Keep screenshots, diagnostics and setup credentials local.

Resume uses the same setup identity and disk, not a second fresh installation. It regenerates setup media from the current service recipe and retries a failed bootstrap once if SSH is reachable. A new bootstrap attempt clears old completion and failure markers before running. A changed environment configuration requires a separate setup.

If SSH cannot start or the firewall blocks it, automatic bootstrap retry cannot reach the guest. The setup may need human console recovery; repeatedly resuming does not fix unreachable SSH. Preserve the setup disk and inspect its screenshot and local diagnostics before deciding how to recover. Do not treat a stopped or unreachable guest as a completed environment, or disable pinned host-key checking to reach it.
