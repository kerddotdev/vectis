---
title: Derive an environment
description: Provision a new immutable image from an existing ready environment.
---

`environment.provision` boots a writable clone of a ready environment, preinstalls the pinned GitHub Actions runner, runs an optional setup script once, shuts down the guest cleanly and registers a new environment. It preserves the parent's base image and runner label. Connect repositories to the new environment ID to use its tools.

```sh
vectis environment provision ubuntu-project --from ubuntu-24-arm64 \
  --image-directory /absolute/path/to/images/ubuntu-project \
  --name "Ubuntu project tools" \
  --setup-script /absolute/path/to/setup.sh \
  --wait --timeout 3600000 --json
```

The image directory must be a new absolute path with an existing writable parent directory. Vectis refuses existing files and directories, including empty ones. The derived environment inherits CPU, memory, disposable VM storage, guest access and effective network settings. Provisioning needs an idle, unpaused machine without unresolved runners or guest setups, and uses the normal VM resource and free-memory checks.

Without `--setup-script`, provisioning only preinstalls the runner and prepares the image for cloning. `--no-runner` skips preinstallation and does not advertise a baked runner in the new manifest; jobs use the verified download fallback. Scripts are limited to 64 KiB of UTF-8. The CLI reads the file and sends its contents as data; the service uploads it into a guest file. Bash runs it as the SSH user on Linux and macOS. Windows uses `powershell.exe` (Windows PowerShell 5.1), not PowerShell Core or Bash. A nonzero script exit fails the operation.

Linux and macOS preinstall the runner in the SSH user's home without requiring sudo. On Linux, provisioning checks the runner's linked libraries and the system libraries required by the pinned runner before attempting dependency installation. Prepared Vectis images already contain these dependencies, so provisioning skips the installer and its package index refresh. If libraries are missing, provisioning attempts the installer only after `sudo -n true` succeeds; otherwise it fails with a diagnostic explaining the missing dependencies and sudo permission. Installer failures are fatal, and a successful installation must pass the library checks again.

Linux setup scripts can use `sudo -n` when the image grants passwordless sudo, as fresh Vectis images do. Linux identity cleanup and clean shutdown still require passwordless sudo; older images without it can preinstall the runner but cannot finish provisioning. Clean macOS shutdown requires passwordless access to `/sbin/shutdown -h now`; configure a narrowly scoped sudoers rule inside the CI guest before provisioning, for example `vectis ALL=(root) NOPASSWD: /sbin/shutdown -h now`. Vectis never requests a guest password. Do not put credentials into setup scripts: remote submissions pass through the cloud command queue.

## Runner and image manifest

New Linux and Windows preparations retain the pinned runner too. Linux and macOS use `$HOME/.vectis-runner/<version>`, and Windows uses `C:\vectis\runner\<version>`. Linux preparation runs preinstallation as `vectis` so the files belong to the same guest user that starts jobs. Downloads retry and verify SHA-256 before extraction. The guest account owns the runner directory so the disposable VM can configure and run it in place.

The optional `Environment.image` manifest records `parentId`, a `revision`, `runnerVersion` when installed, and `provisionedAt`. When `runnerVersion` matches Vectis's pinned version, jobs start that runner directly without copying or downloading it. Existing environments without that manifest, and manifests for other runner versions, retain the verified download path and its 600-second install timeout. A manifest is an installation record, not evidence of a successful GitHub job.

Linux provisioning clears the temporary guest's machine ID and SSH host identity before shutdown. Future instances still receive distinct host keys through the existing read-only identity media. macOS and Windows retain their existing guest identity behavior. Network enforcement is inherited: Linux and macOS NAT do not filter egress; Windows defaults to enforced internet-only access.

## Cancellation, cleanup and parents

```sh
vectis operation get <operation-id> --json
vectis operation cancel <operation-id> --json
vectis environment remove ubuntu-project --json
```

The operation reports cloning, booting, waiting for the guest, provisioning, shutdown and freezing stages. Cancellation stops the owned VM and deletes the partial output. Script failure or a shutdown timeout never registers the image. A forced stop is used only for failure, cancellation or a shutdown timeout, and its disk is discarded. A failed attempt can be retried with a new operation key after cleanup.

Guest command failures retain `exitCode` and a redacted `diagnostics` string in the operation result, available through `operation get --json`. Diagnostics contain the last 4 KiB of stderr followed by the last 4 KiB of stdout, within the 16 KiB diagnostic limit. Step markers such as `vectis-provision: download` identify the failing preinstallation or shutdown step. Connection failures retain the available SSH diagnostic instead of inventing a guest exit code. Diagnostics remain available when cleanup needs attention or is retried after a restart. Treat diagnostic output as potentially sensitive even after redaction.

After a service crash, Vectis retains ownership records and requires verified VM exit before removing partial files. If cleanup is unconfirmed, the operation reports `action_required` and provisioning continues to reserve the host. Reconcile the interrupted instance and restart the service to retry cleanup. A completed registration is recovered without deleting its image.

Windows derived images use QCOW2 overlays with an absolute parent backing path, plus cloned UEFI variables and TPM state. Keep the parent's files in place. All operating systems refuse `environment.remove` for a parent with registered derived environments; remove descendants first. Removing a definition preserves its disk, so any retained Windows overlays still require their backing files even after unregistering.

## CLI, MCP and remote control

MCP's `vectis_command` accepts the same command:

```json
{
  "type": "environment.provision",
  "id": "ubuntu-project",
  "from": "ubuntu-24-arm64",
  "imageDirectory": "/absolute/path/on/host/images/ubuntu-project",
  "setupScript": "set -eu\nprintf 'ready\\n' > \"$HOME/project-ready\"",
  "runner": true
}
```

Remote provisioning follows the existing preparation commands: `--machine <id>` selects the host, `--image-directory` is a path on that host, and `--setup-script` is read on the calling CLI machine before submission. Cancellation uses the same remote operation contract. The existing cloud queue limits the entire serialized command to 64 KiB, including JSON escaping and field overhead; near-limit setup scripts must be submitted locally. Desktop recognizes provisioning activity and cancellation; the environment provisioning form is separate UI work.
