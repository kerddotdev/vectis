import { setTimeout as delay } from "node:timers/promises";
import { VectisError, type Environment, type Instance } from "../../protocol/src/index.js";
import { waitForGuestAddress } from "./guest-address.js";
import { executeGuest, guestArguments, type GuestConnection } from "./guest.js";

export function verifyGuestReadiness(output: string, now = Date.now()) {
  const fields = output.trim().split(/\s+/);
  const timestamp = Number(fields[1]);
  if (fields.length !== 2 || !/^(arm64|aarch64)$/i.test(fields[0] ?? ""))
    throw new VectisError("guest_architecture", "The guest must report native ARM64 architecture.");
  if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp * 1000 - now) > 60000)
    throw new VectisError(
      "guest_clock",
      "The guest clock differs from the host by more than one minute.",
      "Correct time synchronization in the base image before starting another runner.",
    );
}

export async function readyGuest(
  environment: Environment,
  instance: Instance,
  signal: AbortSignal,
): Promise<GuestConnection> {
  if (instance.environmentId !== environment.id || instance.status !== "running")
    throw new VectisError("guest_not_running", "The owned guest is not running.");
  if (!environment.sshUser || !environment.sshKeyPath || !environment.knownHostsPath)
    throw new VectisError(
      "setup_required",
      "The environment needs a guest user, SSH identity and pinned host key.",
      "Complete guest SSH setup before starting a runner.",
    );
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  let host: string;
  let port: number;
  if (environment.os === "windows") {
    if (instance.sshHost !== "127.0.0.1" || !instance.sshPort)
      throw new VectisError("guest_address_unavailable", "The owned VM has no verified SSH port.");
    host = instance.sshHost;
    port = instance.sshPort;
  } else {
    if (!instance.macAddress)
      throw new VectisError("guest_address_unavailable", "The owned VM has no network identity.");
    host = await waitForGuestAddress(instance.macAddress, bounded);
    port = 22;
  }
  const connection = {
    host,
    port,
    user: environment.sshUser,
    identityFile: environment.sshKeyPath,
    knownHostsFile: environment.knownHostsPath,
    hostKeyAlias: environment.id,
  };
  guestArguments(connection);
  const script =
    environment.os === "windows"
      ? "[Console]::WriteLine([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() + ' ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
      : 'set -eu\nprintf \'%s %s\\n\' "$(uname -m)" "$(date -u +%s)"';
  while (!bounded.aborted) {
    try {
      const result = await executeGuest(connection, script, {
        signal: bounded,
        shell: environment.os === "windows" ? "powershell" : "bash",
      });
      if (result.exitCode !== 0)
        throw new VectisError("guest_readiness_failed", "The guest readiness check failed.");
      verifyGuestReadiness(result.stdout);
      return connection;
    } catch (error) {
      if (!(error instanceof VectisError) || error.code !== "guest_unavailable") throw error;
      await delay(1000, undefined, { signal: bounded });
    }
  }
  bounded.throwIfAborted();
  throw new VectisError("guest_unavailable", "The guest did not become ready.");
}
