---
title: Prepare a Linux environment
description: Download and prepare Ubuntu on an Apple Silicon Mac with resumable local setup.
---

The guided Linux path creates an Ubuntu 24.04 ARM64 base image with a local `vectis` user, pinned SSH access, Git, Docker and the official runner's dependencies. It runs through the same local service from desktop, CLI and MCP. It requires an Apple Silicon Mac and the configured Apple helper, which runs the VM through Apple Virtualization. The service converts the downloaded disk itself; `qemu-img` is not needed.

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

## What the image contains

A prepared image is a runner host, not a copy of a GitHub-hosted runner. GitHub's images carry hundreds of preinstalled tools and tens of gigabytes; Vectis instead gives a workflow what it needs to install its own toolchain at job time:

- Git, Docker, OpenSSH and the official runner's dependencies.
- The archive tools and certificates setup actions use: `tar`, `gzip`, `xz-utils`, `zip`, `unzip`, `zstd`, `ca-certificates`, `jq`, `curl`, `rsync`.
- The shared libraries prebuilt toolchains link against, including `libatomic1`, `libicu`, `libssl`, `libstdc++` and `zlib`.

So `actions/setup-node`, `actions/setup-python`, `actions/setup-java`, `pnpm/action-setup`, `actions/cache` and similar actions work. A job that expects a preinstalled compiler, database or cloud CLI has to install it in a step, or run it in a container, because every VM starts from the same base image and nothing a job installs survives it. The base image cannot be customized yet.

## Cancel and resume

```sh
vectis operation cancel <operation-id> --json
vectis operation get <operation-id> --json
vectis environment resume <setup-id> --json
```

A stopped or failed setup reports `action_required` and its durable `setupId`. Partial downloads are retained and verified on continuation. A cancelled or failed guest configuration restarts from the clean downloaded image. Previously completed stages do not require manually recreating keys or directories.

After a service crash, the previous guest must have verifiable process-exit evidence before its disk can be rewritten. Vectis will not kill an unrelated process or assume that a stored PID still belongs to it. The private `preparation.log` remains in the operation's reported image directory for diagnosis.

Completed setup registers the environment automatically. It does not connect a repository or prove a GitHub job has run. Continue with [Repositories and labels](/docs/guides/repositories), then [Runners and jobs](/docs/guides/runners).
