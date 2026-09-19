---
title: VM storage and resources
description: Choose VM locations, CPU and memory limits, and inspect disk usage.
---

Choose an existing writable directory for VM working disks. It can be on an external drive. Keep prepared base images wherever you prefer; `basePath` locates the source and `storagePath` chooses where disposable instances are created.

Example `environment.json` for an already prepared Linux image:

```json
{
  "id": "ubuntu",
  "name": "Ubuntu ARM64",
  "os": "linux",
  "basePath": "/Volumes/CI/Images/ubuntu-arm64.img",
  "storagePath": "/Volumes/CI/VMs",
  "cpu": 2,
  "memoryMiB": 4096,
  "state": "ready"
}
```

Register it and start a VM:

```sh
vectis environment register --file environment.json --wait --json
vectis environment start ubuntu --wait --json
```

The original base image is preserved. The instance receives its own working disk and directory. Stopping an owned instance removes its disposable working directory, preserving the selected parent directory and base image.

## Change defaults or one VM

Change defaults for future instances:

```sh
vectis environment configure ubuntu --cpu 4 --memory-mib 8192 --storage-path /Volumes/CI/VMs --wait --json
```

Override just one start without changing defaults:

```sh
vectis environment start ubuntu --cpu 2 --memory-mib 4096 --wait --json
```

Running instances keep the resources and location they started with. Changing a path does not move existing disks. Vectis validates the per-instance request and the combined CPU and memory reservations. Memory reservations may use at most 75 percent of host RAM; startup also checks available memory.

If a selected directory disappears, Vectis reports `storage_unavailable`. Reconnect the drive before retrying. It does not silently recreate a missing selected directory on the system disk. Storage is currently identified by path, so verify that the intended drive is mounted there.

## Understand disk usage

```sh
vectis storage --json
```

The report separates base images from active and interrupted instances and includes a host-file breakdown when inspection succeeds.

| Metric                 | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `virtualCapacityBytes` | The virtual disk capacity exposed to the guest                            |
| `fileBytes`            | The apparent size of image and support files on the host                  |
| `allocatedBytes`       | Filesystem-reported allocated blocks                                      |
| `entries`              | Usage grouped by files or directories immediately inside the VM directory |
| `guestBreakdown`       | Availability of guest filesystem inspection                               |

Sparse files can have a large capacity and use fewer host blocks. Copy-on-write clones can share blocks, so summing `allocatedBytes` does not measure exclusive physical consumption. Guest filesystem breakdown is currently unavailable: the report cannot yet tell you how much space is used by guest packages, caches, or build files inside a disk image.

## Background access to external storage

A path that works from Terminal may still be inaccessible to the installed background runtime. Keep the volume mounted and check the runtime's access under **System Settings > Privacy & Security > Files and Folders**. Selecting a folder in the desktop does not by itself prove that the independent service has permission to read it. Vectis does not grant Full Disk Access or change system privacy settings automatically.

Storage measurements run in a separate owned process with a deadline. A blocked or unavailable volume returns an unavailable result with next steps instead of leaving the measurement pending indefinitely. Concurrent requests share the current measurement, and stopping the service cancels it. This protects inspection; it does not bypass permission requirements for VM startup or image preparation.

Before starting a VM, Vectis also checks image reads and storage-directory access in a separate process. If access cannot be confirmed within five seconds, startup returns `action_required` with `storage_access_required`. No VM or work directory is created by that failed preflight. Resolve the permission or mount issue, then retry with a new operation key. This check cannot guarantee that a volume will remain connected or accessible throughout a later job.
