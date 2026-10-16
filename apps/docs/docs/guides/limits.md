---
title: Limits and boundaries
description: The numeric limits, timeouts and retention windows Vectis applies today.
---

These values describe the current release. Settings you can change are marked as such.

## Runners and capacity

| Limit                                                | Value                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Time a runner waits for and runs a job               | 6 hours                                                                                              |
| Time allowed for installing the runner in the guest  | 10 minutes                                                                                           |
| Concurrent VMs                                       | 5 by default, 1 to 16 with `vectis machine configure --max-runners` or **Concurrent VMs** in the app |
| CPU used by all starting and running VMs together    | At most the host's CPU cores                                                                         |
| Memory used by all starting and running VMs together | At most 75% of the host's memory                                                                     |
| Concurrent macOS VMs                                 | 2 (an Apple limit)                                                                                   |

An automatic runner also waits while an environment is being prepared, while an interrupted instance is unresolved, and while the Mac is paused. A runner that has been accepted holds its slot, and its CPU and memory, before its VM starts.

## Environments

| Environment | Default CPU | Default memory | Default disk |
| ----------- | ----------- | -------------- | ------------ |
| Ubuntu      | 2           | 4096 MiB       | 32 GiB       |
| macOS       | 2           | 4096 MiB       | 64 GiB       |
| Windows     | 4           | 8192 MiB       | 96 GiB       |

Override them with `--cpu`, `--memory-mib` and `--disk-gib`. Minimum disk sizes are 16 GiB for Ubuntu, 40 GiB for macOS and 64 GiB for Windows. A VM's memory can never exceed 75% of the host's memory. See [Storage and resources](/docs/guides/storage).

## Cloud and automation

| Limit                                              | Value                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| Active runner leases per Mac                       | 100                                               |
| Lifetime of a runner's just-in-time configuration  | 15 minutes                                        |
| Automatic runner failures per job                  | 3                                                 |
| Total automatic runner attempts per job            | 10                                                |
| Wait after an action-required or missing operation | 10 minutes                                        |
| Wait after a failed attempt                        | 60 seconds                                        |
| Unclaimed automatic runner request, Mac offline    | Expires after 2 minutes                           |
| Unclaimed automatic runner request, Mac online     | Expires after 10 minutes                          |
| Scan for jobs Vectis missed                        | At most every 5 minutes per repository connection |
| Jobs listed per repository connection              | The latest 100                                    |
| Lines returned by one service log read             | At most 1000                                      |
| Runner diagnostics                                 | At most 16 KiB                                    |
| Pairing requests                                   | Expire after 10 minutes                           |
| Controller grants                                  | Expire after 90 days                              |

## History and retention

On the Mac, finished activity history expires after 30 days. Beyond the newest 300 completions, entries older than 24 hours expire too. Unfinished work stays. See [Troubleshooting](/docs/guides/troubleshooting#an-operation-failed-or-needs-you).

In the cloud:

| Record                                   | Kept                            |
| ---------------------------------------- | ------------------------------- |
| GitHub webhook deliveries                | 30 days                         |
| Jobs                                     | 90 days                         |
| Operations                               | 90 days                         |
| Runner leases                            | 30 days                         |
| Controllers                              | 30 days after the grant expires |
| Expired pairing and GitHub link requests | 1 day after they expire         |
| Workflow migration previews              | 24 hours                        |

Jobs, operations and leases that have not finished are not removed.

## Hosts and guests

- The host is an Apple Silicon Mac running macOS 15 or later. Intel Macs are not supported.
- Guests are ARM64 only: Ubuntu, macOS and Windows 11 ARM64.
- Windows support is experimental.
