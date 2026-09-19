---
title: Operations and output
description: Operation states, idempotency keys, waiting, exit codes, errors, labels and environment variables.
---

## Operations

Every change is an operation recorded by the service before anything happens. Its `status` is one of:

| Status            | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `accepted`        | Recorded; work has not started                      |
| `running`         | In progress                                         |
| `action_required` | Stopped safely; `nextStep` says what you need to do |
| `succeeded`       | Finished, including cleanup                         |
| `failed`          | Finished without success; `message` says why        |
| `cancelled`       | Cancelled, with cleanup finished                    |

Operations have a `message`, often a `nextStep`, and for some commands a `result`.

## Idempotency keys

Each command carries a key (`--key` in the CLI, `key` in MCP). Submitting the same key and command again returns the original operation instead of doing the work twice, which makes retries after a timeout or a dropped connection safe. The CLI generates a random key when you omit it. Reusing a key for a different command is rejected.

## Waiting

`--wait` or `vectis operation wait <id>` waits until the operation leaves `accepted` and `running`, for up to `--timeout` milliseconds (default 120000). If time runs out, the CLI prints the operation as it is and exits with 3; the operation keeps going. MCP `vectis_wait` waits up to 120 seconds per call and returns `timedOut: true` in the same case. Stopping a wait never cancels the operation; use `vectis operation cancel <id>` for that.

## Output and exit codes

The CLI always prints JSON: indented by default, compact with `--json`.

| Exit code | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| 0         | Success                                                            |
| 1         | The operation failed or was cancelled, or the command was rejected |
| 3         | The operation needs you (`action_required`) or is still running    |

Errors are printed as:

```json
{
  "error": {
    "code": "machine_paused",
    "message": "The machine is paused.",
    "nextStep": "Run vectis resume."
  }
}
```

`code` is stable for scripts and agents; `nextStep` is written for people.

## Runner labels

Every runner carries `self-hosted`, its OS label (`Linux`, `macOS` or `Windows`), `ARM64` and `vectis-<environment-id>`. A job reaches it when its `runs-on` includes `vectis-<environment-id>` and only labels from that list. See [Repositories and labels](/docs/guides/repositories#choose-the-runs-on-label).

## Environment variables

| Variable                                         | Effect                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `VECTIS_HOME`                                    | State directory, like `--home`                                          |
| `VECTIS_APPLE_HELPER`, `VECTIS_KEYCHAIN_HELPER`  | Native helpers; set automatically by the app and its command line tools |
| `VECTIS_QEMU`, `VECTIS_QEMU_IMG`, `VECTIS_SWTPM` | Windows runtime executables                                             |

Source checkouts also read `CONVEX_URL` and `VECTIS_WEB_URL`; see [Build from source](/docs/self-hosting/build-from-source).
