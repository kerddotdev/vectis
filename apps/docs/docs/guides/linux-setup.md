---
title: Prepare a Linux environment
description: Download and prepare Ubuntu on an Apple Silicon Mac with resumable local setup.
---

The guided Linux path creates an Ubuntu 24.04 ARM64 base image with a local `vectis` user, pinned SSH access, Git, Docker the pinned Actions runner and its dependencies. It runs through the same local service from desktop, CLI and MCP. It requires an Apple Silicon Mac and the configured Apple helper, which runs the VM through Apple Virtualization. The service converts the downloaded disk itself; `qemu-img` is not needed.

Choose existing writable directories for base images and disposable VMs. They may be on an external drive. The image volume needs at least 8 GiB free; actual usage grows as software is installed. Virtual disk capacity is separate from allocated host storage.

```sh
vectis environment prepare-linux ubuntu-24-arm64 \
  --image-directory /absolute/path/to/images \
  --storage-path /absolute/path/to/vms \
  --cpu 2 --memory-mib 4096 --disk-gib 32 --json
vectis operation wait <operation-id> --timeout 3600000 --json
```

Use **Environments > Prepare a guest image**, with **Ubuntu 24.04 ARM64** selected, in the desktop. MCP accepts `environment.prepare-linux` with the same fields. Preparation currently reserves the host for one setup at a time: stop existing VMs and resolve interrupted runners first. Normal VM admission is blocked during preparation; pausing, diagnostics and cancellation remain available.

The service downloads a pinned official Ubuntu QCOW2 image, checks its exact size and SHA-256, converts it to a bootable raw disk, and performs guest configuration locally. The source revision is recorded beside the completed image. Installed package versions are available inside the guest at `/etc/vectis/toolchain-versions.txt`. No host home directory, Docker socket or GitHub App key is shared with the guest.

Each disposable instance receives its own SSH host key through private, read-only setup media. Images prepared with a shared SSH host key must be prepared again before starting runners; Vectis reports `action_required` for those images. To keep the same environment ID, and with it the `vectis-<id>` runner label and existing repository connections, remove the old environment and prepare the new image under that ID. Removing an environment keeps its image files on disk.

## Network access

Apple Virtualization NAT does not enforce egress filtering. The guest can reach the internet, the host and the local network. Status reports `network: { egress: "open", enforcement: "not_enforced" }`, including for existing environments without an explicit setting.

`vectis environment configure <id> --egress open --json` is accepted. Requesting `internet_only` fails with `egress_unsupported`: "Apple Virtualization NAT cannot restrict guest network access yet; this environment can reach the host and local network." Windows environments support enforced internet-only egress. Inspect effective state with `vectis status --json`, `vectis environment list --json` or MCP `vectis_status`; MCP uses the same configuration command.

## What the image contains

A prepared image is a runner host, not a copy of a GitHub-hosted runner. GitHub's Ubuntu ARM64 image is built by 63 provisioning steps and carries hundreds of preinstalled tools, which does not belong in a disposable VM on a personal Mac. What a workflow actually depends on is narrower, because `actions/setup-*` actions download toolchains at job time. That is the layer Vectis matches, and it takes the list from the same place GitHub does: the `apt` section of [the Ubuntu 24.04 ARM64 toolset](https://github.com/actions/runner-images/blob/main/images/ubuntu/toolsets/toolset-2404-arm64.json) in `actions/runner-images`.

So a prepared guest has Git, Docker, OpenSSH and the official runner's dependencies, the archive and shell tools that actions invoke (`tar`, `gzip`, `xz-utils`, `zip`, `unzip`, `zstd`, `p7zip-full`, `jq`, `curl`, `wget`, `rsync`, `shellcheck`), a C and C++ toolchain with the headers native modules build against (`gcc`, `g++`, `make`, `pkg-config`, `autoconf`, `automake`, `libtool`, `libssl-dev`, `libsqlite3-dev`, `libicu-dev`), and the shared libraries prebuilt binaries link against, `libatomic1` among them. Two packages differ from GitHub's list: `p7zip-rar` is left out because it is non-free, and `netcat` and `upx` are installed under their real package names. The complete inventory of a prepared image is in the guest at `/etc/vectis/toolchain-versions.txt`.

Deliberately absent: language runtimes and their version managers, databases, browsers and drivers, cloud CLIs, Android and Java SDKs. A job that needs one installs it in a step, or runs in a container with `container:` in the workflow, which works because the guest runs Docker. Nothing a job installs survives it, since every VM starts from the same base image. To bake shared tools into a new base, [derive an environment](/docs/guides/environments) with `environment.provision`; the original stays immutable.

Docker container jobs (`container:`) and service containers (`services:`) are supported on the Ubuntu environment and covered by the environment validation workflow.

## Run x86_64 Linux tools

Enable Rosetta per Linux environment to run x86_64 Linux binaries and Docker images requested with `docker run --platform linux/amd64`. The Mac must have Rosetta installed, and the Linux image must have been prepared with Rosetta guest support. Older images need re-preparation; enabling the option alone does not update an image. Prepare a new Linux environment and reconnect its repositories if the existing image lacks support.

```sh
# Run on the Mac if Rosetta is not installed:
softwareupdate --install-rosetta
vectis environment configure ubuntu-24-arm64 --x64 rosetta --json
# Run inside a job:
docker run --rm --platform linux/amd64 ubuntu:24.04 uname -m
# Disable translation for future instances:
vectis environment configure ubuntu-24-arm64 --x64 off --json
```

Vectis shares only [Apple's read-only Rosetta runtime](https://developer.apple.com/documentation/virtualization/running-intel-binaries-in-linux-vms) with an opted-in Linux guest. A conditional boot unit mounts it read-only at `/run/rosetta` and registers an x86_64 ELF handler with `binfmt_misc`. It registers after `systemd-binfmt` has finished, so the normal boot registration cannot clear the handler. The `CF` flags preserve binary credentials and keep the interpreter available in container mount namespaces. The mount attempt is the unit condition: a missing tag skips registration without failing the unit, including on Ubuntu kernels that do not expose a sysfs tag file.

Instance startup verifies the guest handler before reporting success. Missing host support reports `rosetta_not_installed` or `rosetta_unsupported`; a missing or disabled guest handler reports `rosetta_guest_unprepared` with the next step "Prepare the Linux environment again". Translation does not provide x86_64 libraries for standalone dynamically linked binaries; the binary needs compatible libraries, for example inside an amd64 container.

The runner and guest kernel stay ARM64. Jobs requesting `X64` labels still do not match, and `setup-*` actions still install ARM64 tools by default. Rosetta does not change label matching or workflow migration.

The setting applies to future instances. Like other environment configuration changes, enabling or disabling it changes `environmentRevision`, invalidates previous environment evidence and prevents preparing runner leases from completing against the old revision. Those attempts need cleanup and a fresh lease.

## Cancel and resume

```sh
vectis operation cancel <operation-id> --json
vectis operation get <operation-id> --json
vectis environment resume <setup-id> --json
```

A stopped or failed setup reports `action_required` and its durable `setupId`. Partial downloads are retained and verified on continuation. A cancelled or failed guest configuration restarts from the clean downloaded image. Previously completed stages do not require manually recreating keys or directories.

After a service crash, the previous guest must have verifiable process-exit evidence before its disk can be rewritten. Vectis will not kill an unrelated process or assume that a stored PID still belongs to it. The private `preparation.log` remains in the operation's reported image directory for diagnosis.

Completed setup registers the environment automatically. It does not connect a repository or prove a GitHub job has run. Continue with [Repositories and labels](/docs/guides/repositories), then [Runners and jobs](/docs/guides/runners).

New preparations retain the pinned runner under `$HOME/.vectis-runner/<version>` as the guest user and record it in `Environment.image`. Jobs use it directly when the recorded version matches. [Environment provisioning](/docs/guides/environments) can preinstall the runner on an existing ready image without sudo or reinstalling Ubuntu when its prepared libraries are present. Completing provisioning still requires passwordless sudo for identity cleanup and clean shutdown.
