---
title: Install a Windows guest
description: Prepare a local Windows 11 ARM64 image with private setup credentials and pinned SSH access.
---

Windows support is **experimental**. It installs Windows 11 ARM64 from your own ISO with QEMU and Apple's Hypervisor framework, and it does not fall back to slow CPU emulation. The Vectis app does not include QEMU, the software TPM or UEFI firmware; you install them yourself as described below.

## Prerequisites

Vectis needs four programs and two firmware files:

- **QEMU 11.1.1 with both Vectis patches for TPM compatibility and network isolation.** Stock QEMU is not accepted. Build it by following [the QEMU build notes](https://github.com/kerddotdev/vectis/blob/main/native/qemu/README.md); `qemu-img` comes from the same build or from Homebrew (`brew install qemu`).
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

Windows environments default to `internet_only` egress, reported as `network: { egress: "internet_only", enforcement: "enforced" }` in status. Guests use IPv4 internet access. Host addresses, loopback, private networks and link-local destinations are blocked by the patched QEMU runtime. Virtual DNS, DHCP and the owned SSH forward on host loopback remain available; guest administrator changes cannot disable the host filter.

You can deliberately select weaker networking for future instances:

```sh
vectis environment configure windows-11-arm64 --egress open --json
# Restore the default restriction for future instances:
vectis environment configure windows-11-arm64 --egress internet_only --json
```

`open` disables the host egress filter and allows the guest to reach host and local network services. Status reports `network: { egress: "open", enforcement: "not_enforced" }`. It still requires the patched Vectis QEMU runtime and keeps IPv6 disabled. Installation always uses internet-only egress. Changing the setting affects future instances, invalidates previous environment evidence and leaves running instances unchanged. Inspect it with `vectis status --json`, `vectis environment list --json` or MCP `vectis_status`; MCP configuration uses the same `environment.configure` command.

The service reports success only after checking guest ARM64 architecture, clock synchronization and the setup marker over SSH, then observing a completed guest shutdown. It removes temporary setup media after completion. A successful setup registers the base environment; connecting a repository and observing its first Actions job are separate steps.

## What the guest contains

Fresh installation and `environment provision` install the same pinned, SHA-256-verified Windows toolchain. Provisioning runs under Windows PowerShell 5.1 and requires an elevated guest administrator:

- [Git for Windows 2.55.0.5 ARM64](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5), including Bash at `C:\Program Files\Git\bin\bash.exe` and GNU tar at `C:\Program Files\Git\usr\bin\tar.exe`. Bash and Git are on the machine PATH. The installer includes Git LFS; Bash and GNU tar are part of its base payload. Optional desktop integration and automatic Git updates are omitted. Git is configured system-wide with `http.sslBackend schannel`, so it verifies certificates against the Windows certificate store and Microsoft's distrust list instead of the CA bundle that ships with Git. Revocation checking stays on.
- [zstd 1.5.7](https://github.com/facebook/zstd/releases/tag/v1.5.7) at `C:\Program Files\zstd`, on the machine PATH. This release has no Windows ARM64 build, so Vectis uses the official x64 executable through Windows 11 ARM64's x64 emulation and verifies that it runs.
- [PowerShell 7.6.6 ARM64](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6), installed by MSI at `C:\Program Files\PowerShell\7`, with `pwsh` on the machine PATH. Automatic Microsoft Update integration and PowerShell remoting are not enabled. Windows PowerShell 5.1 remains the provisioning shell.

The [Actions cache toolkit prefers GNU tar at the standard Git installation path](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/tar.ts), and uses zstd when available. Windows' built-in bsdtar remains available, but is not the cache toolkit's preferred executable after provisioning. In a lead-reported measurement on the same Windows 11 ARM64 guest with a 679 MB pnpm store, GNU tar with zstd compressed the store in 6.5-6.8 seconds, compared with 11.7-14.0 seconds for bsdtar with gzip. These are local archive compression timings, not end-to-end Actions cache save or restore timings.

Existing MinGit files stay in `C:\Program Files\MinGit` for callers using absolute paths. Only its exact machine PATH entries (`cmd` and `bin`, ignoring case and trailing slashes) are removed. The full Git's `bin`, `cmd` and `usr\bin` entries take priority, and other machine PATH entries are preserved. MinGit is no longer installed in fresh images. PATH checks accept multiple matches and verify only the first resolved Git, Bash, tar, zstd and pwsh executable. Both full Git `bin\git.exe` and `cmd\git.exe` are accepted; tar must resolve to the installed GNU tar.

Downloads use basic parsing to avoid the [Windows PowerShell 5.1 web-content confirmation prompt](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest?view=powershell-5.1), with bounded retries and SHA-256 verification before installation or extraction. Repeating provisioning checks the pinned versions and required binaries before deciding whether to install them again. Temporary downloads are removed even on failure.

Languages, build tools, SDKs and package managers still come from workflow steps or a custom provisioning script. Nothing installed during a job survives that job's disposable VM.

## Disposable guest performance settings

Vectis configures a Microsoft Defender policy exclusion for the entire `C:\` drive inside the disposable Windows guest. It takes effect at the next boot, including with Tamper Protection enabled; it has no effect during the preparation boot that writes the policy. Realtime protection may remain enabled after reboot while excluding `C:\` from scanning.

The VM boundary isolates the host from untrusted job code. Each job gets a fresh disposable VM, so reducing guest antivirus scanning is an acceptable performance tradeoff for this CI environment. Host protection stays enabled. Do not apply these settings to the host or a general-purpose Windows machine.

AMSI can nondeterministically reject Defender-changing PowerShell cmdlets with `ScriptContainedMaliciousContent`. Even a single `Add-MpPreference -ExclusionPath 'C:\'` command that succeeded once was blocked later in the same guest. Separating cmdlets into individual processes is not reliable. Vectis therefore never uses `Add-MpPreference` or `Set-MpPreference` for configuration.

Fresh installation and provisioning write only registry policies through individual `reg.exe` commands in `cmd.exe`, before the toolchain script. The fresh-install seed stores each command in a separate `.cmd` file. Both exclusion writes are required:

```cmd
reg.exe add "HKLM\SOFTWARE\Policies\Microsoft\Windows Defender\Exclusions" /v Exclusions_Paths /t REG_DWORD /d 1 /f
reg.exe add "HKLM\SOFTWARE\Policies\Microsoft\Windows Defender\Exclusions\Paths" /v "C:\\" /t REG_SZ /d 0 /f
```

The realtime, behavior, IOAV, script and on-access protection policy keys, cloud reporting and sample submission policies remain best-effort writes. [Tamper Protection can block or silently ignore attempts to disable protection](https://learn.microsoft.com/en-us/defender-endpoint/tamper-protection-overview). Modern Defender ignores `DisableAntiSpyware`. Successful policy writes do not prove realtime protection is off.

The mandatory toolchain manifest records `Defender.Mode: policy-exclusion`, `Defender.PolicyExclusionPath: ["C:\\"]` and `Defender.AppliesAt: next-boot`. These fields describe configuration intent, not an observed effective exclusion. Preparation does not depend on `Get-MpPreference` or `Get-MpComputerStatus`: before reboot, a missing effective exclusion is expected. Read-only checks remain useful after boot.

Windows Update is disabled through `NoAutoUpdate` policy and `wuauserv`; Windows Search indexing (`WSearch`) and SysMain are disabled and stopped. Vectis also attempts to disable and stop Update Orchestrator (`UsoSvc`) and Update Medic (`WaaSMedicSvc`). Windows can protect those two services: blocked changes produce a warning and their actual state is recorded rather than reported as disabled. HVCI / Memory Integrity's `Enabled` value is set to `0` when present; running HVCI is recorded as requiring a reboot, and needs a real guest check after reboot.

The toolchain steps emit `vectis-provision: <step>` markers. Versions, Windows build, next-boot Defender policy configuration, service states, Update policy and HVCI state are merged into `C:\ProgramData\Vectis\toolchain.json`, preserving unrelated manifest fields.

### Verify the next boot

Provisioning ends with a hypervisor shutdown, with a guest shutdown fallback, and confirms the VM has exited before registering the derived image. Fresh installation does not reboot inside the bootstrap script: `windows-installation` observes its prepared marker, verifies the runner, issues `shutdown.exe /s /t 3`, waits for the VM to exit, and only then writes `image.json` and finalizes the environment. Both paths therefore save a stopped image after writing the policy. Every job boots a new instance from that image, applying the exclusion at that boot. Tools and custom setup scripts running before this shutdown do not yet benefit from a newly written exclusion.

Vectis removes the obsolete `Vectis-VerifySecurity` startup task and its script and receipts when provisioning existing images. It does not reapply Defender settings or verify them automatically at runner start. The manifest records preparation-time configuration, not proof of the current boot's state.

After the lead boots a newly provisioned image or clone, check in the guest:

```powershell
Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, IsTamperProtected
(Get-MpPreference).ExclusionPath
Get-Content C:\ProgramData\Vectis\toolchain.json -Raw
Get-Service wuauserv, UsoSvc, WaaSMedicSvc, WSearch, SysMain
Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard | Select-Object SecurityServicesRunning
```

After boot, `ExclusionPath` should contain `C:\`; realtime protection may remain `True` with Tamper Protection enabled. The lead confirmed this policy exclusion after reboot in the same Windows 11 ARM64 guest: with a 679 MB pnpm store, `pnpm install` took 24.5 seconds with the exclusion versus 91-100 seconds without it. This is measured guest evidence for that setup, not a timing guarantee for every job. Check running HVCI and service states separately, and measure dependency installation and cache save/restore timings for the workload being evaluated.

## Interruption and recovery

```sh
vectis operation cancel <operation-id> --json
vectis environment resume-windows <setup-id> --json
```

Closing the desktop does not cancel the service operation. Cancellation preserves the owned disk for diagnosis and resume. The previous VM must have a matching exit receipt before another attempt is admitted. An uncertain process state blocks new VM starts.

An interrupted operation reports `action_required` with the setup ID and private directory. Its `setup.ppm` screenshot and `preparation.log` can help diagnose guest setup failures. The preparation log contains host runtime output; guest command failures also emit a bounded full PowerShell error record to stderr. The bootstrap records its failing stage, error message and script line in `C:\ProgramData\Vectis\diagnostic.json`. When SSH remains reachable, Vectis saves a bounded copy as `bootstrap-diagnostic.json` in the private setup directory before stopping the VM. Only the known stage appears in the operation message; the detailed error stays local. Older setup media may have only the generic failure marker. Keep screenshots, diagnostics and setup credentials local.

Resume uses the same setup identity and disk, not a second fresh installation. It regenerates setup media from the current service recipe and retries a failed bootstrap once if SSH is reachable. A new bootstrap attempt clears old completion and failure markers before running. A changed environment configuration requires a separate setup.

If SSH cannot start or the firewall blocks it, automatic bootstrap retry cannot reach the guest. The setup may need human console recovery; repeatedly resuming does not fix unreachable SSH. Preserve the setup disk and inspect its screenshot and local diagnostics before deciding how to recover. Do not treat a stopped or unreachable guest as a completed environment, or disable pinned host-key checking to reach it.

## Derive a prepared image

Fresh Windows preparations preinstall the verified pinned Actions runner at `C:\vectis\runner\<version>` and record its version in `Environment.image`, so jobs start it in place. Existing ready environments can gain the runner or repository tools with [environment provisioning](/docs/guides/environments). Setup scripts run as the guest SSH user under Windows PowerShell 5.1 (`powershell.exe`). A derived disk is a QCOW2 overlay: keep its parent backing image in place and remove registered descendants before their parent.
