---
title: Limits and boundaries
description: The numeric limits, timeouts and retention windows Vectis applies today.
---

These values describe the current release. Settings you can change are marked as such.

## Runners and capacity

| Limit                                                | Value                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Time a runner waits for and runs a job               | 6 hours                                                                                                |
| Time allowed for installing the runner in the guest  | 10 minutes                                                                                             |
| Idle runner drain when capacity is no longer needed  | 5 minutes, including manual runners without a requested job                                            |
| GitHub reports a listening runner offline or missing | 2 consecutive minutes                                                                                  |
| Continuous runner status read failures               | 15 minutes before offline recovery                                                                     |
| Automatic interrupted-runner cleanup                 | 24 hours, retry delays doubling from 1 minute to 30 minutes                                            |
| Concurrent VMs                                       | 5 by default, 1 to 16 with `vectis machine configure --max-runners` or **Concurrent VMs** in the app   |
| CPU ceiling per VM                                   | At most the host's CPU cores; summed vCPUs may exceed host cores                                       |
| Shared VM memory admission budget                    | 75% of host RAM by default; `machine configure --memory-budget-mib` accepts 2048 MiB to total host RAM |
| Startup memory estimate                              | Linux 2048 MiB; macOS and Windows 4096 MiB; capped by each VM's ceiling                                |
| Host memory pressure                                 | Warning or critical blocks new starts; unknown is reported and treated as normal                       |
| Concurrent macOS VMs                                 | 2 (an Apple limit)                                                                                     |

An automatic runner also waits while an environment is being prepared, while the Mac is paused, or when unresolved instances leave insufficient capacity. A runner that has been accepted holds its slot and startup memory estimate before its VM starts. Each non-stopped VM commits the larger of its measured process RSS and startup estimate; failed measurements fall back to its configured ceiling. Probes are cached for five seconds. `runnerCapacity.budget` reports the effective memory budget, committed memory, host RAM, pressure and whether pressure is known. The budget gates admission; it does not reclaim memory or stop VMs that later grow beyond it.

## Environments

The warm pool is opt-in: `environment configure <id> --warm-pool <N>` accepts 0 to 4, default 0. Idle pool VMs consume host RAM and disk space under the same admission budget and pressure gate as other VMs. Pool filling leaves one runner slot and a startup memory estimate free, so the actual size can be smaller than requested, including zero at a one-runner limit. Owned warm VMs yield to jobs and count as reclaimable capacity, while their memory stays visible in `runnerCapacity.budget`. They contain no runner registration, JIT configuration or job credentials. Idle VMs are recycled after 30 minutes and drained on pause, disable or service shutdown. See [Runners and jobs](/docs/guides/runners#optional-warm-pool).

| Environment | Default CPU | Default memory | Default disk |
| ----------- | ----------- | -------------- | ------------ |
| Ubuntu      | 2           | 4096 MiB       | 32 GiB       |
| macOS       | 2           | 4096 MiB       | 64 GiB       |
| Windows     | 4           | 8192 MiB       | 96 GiB       |

Override them with `--cpu`, `--memory-mib` and `--disk-gib`. Minimum disk sizes are 16 GiB for Ubuntu, 40 GiB for macOS and 64 GiB for Windows. A VM's configured memory ceiling can never exceed 75% of host memory. Ceilings remain fixed for a running VM, but unused memory is allocated lazily and summed ceilings may exceed host RAM. For a suitable host, consider Linux 8 vCPUs / 12288 MiB, Windows 8 / 16384 MiB, and macOS 6 / 12288 MiB; preparation defaults are unchanged. See [Storage and resources](/docs/guides/storage).

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
