import { join } from "node:path";
import { Schema } from "effect";
import {
  VectisError,
  type Command,
  type Environment,
  type Operation,
} from "../../../packages/protocol/src/index.js";
import { prepareMacAccess } from "../../../packages/runner/src/macos-access.js";
import { waitForGuestAddress } from "../../../packages/runner/src/guest-address.js";
import { executeGuest } from "../../../packages/runner/src/guest.js";
import { verifyGuestReadiness } from "../../../packages/runner/src/guest-ready.js";
import { runProcess } from "../../../packages/runner/src/process.js";
import { preparationStopped } from "../../../packages/runner/src/preparation-process.js";
import { MacInstallationRecord } from "./macos-installation-task.js";
import type { Store } from "./store.js";

function setup(store: Store, id: string) {
  const value = store.get("macInstallation", id);
  if (!value) throw new VectisError("setup_missing", "This macOS installation was not found.");
  return Schema.decodeUnknownSync(MacInstallationRecord)(value);
}
// Reported as one pipe-separated line so a guest without developer tools still answers: every one
// of these commands exists on a bare macOS as an xcrun shim and fails when nothing backs it.
export const macToolchainProbe =
  "developer=$(/usr/bin/xcode-select -p 2>/dev/null || true)\n" +
  "git=$(/usr/bin/git --version 2>/dev/null || true)\n" +
  "clang=$(/usr/bin/clang --version 2>/dev/null | /usr/bin/head -1 || true)\n" +
  "swift=$(/usr/bin/swift --version 2>/dev/null | /usr/bin/head -1 || true)\n" +
  'printf \'%s|%s|%s|%s\\n\' "${developer:-none}" "${git:-none}" "${clang:-none}" "${swift:-none}"';

export function verifyMacSetupOutput(output: string) {
  const lines = output
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (lines.length !== 4 || !lines[2]?.startsWith("26."))
    throw new VectisError("guest_os_version", "This setup requires a macOS 26 guest.");
  verifyGuestReadiness(lines[0] ?? "");
  if (lines[1] !== "FileVault is Off.")
    throw new VectisError(
      "guest_filevault_enabled",
      "Guest FileVault prevents unattended clone startup.",
      "Disable FileVault inside this CI guest, wait for decryption, then verify again. Do not change host encryption.",
    );
  const [developer = "none", git = "none", clang = "none", swift = "none"] = (lines[3] ?? "").split(
    "|",
  );
  // Without a developer directory there is no git, so actions/checkout cannot run and almost no
  // workflow would get past its first step.
  if (developer === "none" || !git.startsWith("git version"))
    throw new VectisError(
      "guest_developer_tools",
      "The guest has no developer toolchain, so git is unavailable to jobs.",
      "In the guest's setup console, run xcode-select --install for the Command Line Tools, or install Xcode and open it once to accept its license, then verify again.",
    );
  return { developer, git, clang, swift };
}
export async function startMacGuestAccess(
  store: Store,
  operation: Operation,
  command: Extract<
    Command,
    { type: "environment.connect-macos-guest" | "environment.verify-macos-guest" }
  >,
) {
  const record = setup(store, command.id);
  if (
    record.phase !== "setup_running" ||
    !record.macAddress ||
    !record.bundle ||
    (await preparationStopped(record.directory, record.attemptId))
  )
    throw new VectisError(
      "guest_setup_not_running",
      "Open this guest's setup console before connecting it.",
      `Use environment open-macos-setup ${record.id}.`,
    );
  const macAddress = record.macAddress;
  const active = store
    .snapshot()
    .operations.some(
      (item) =>
        item.id !== operation.id &&
        ["environment.connect-macos-guest", "environment.verify-macos-guest"].includes(
          item.command,
        ) &&
        ["accepted", "running"].includes(item.status) &&
        Schema.is(Schema.Struct({ setupId: Schema.String }))(item.result) &&
        item.result.setupId === record.id,
    );
  if (active)
    throw new VectisError("guest_setup_busy", "Guest access preparation is already running.");
  operation = store.update(operation, {
    result: { setupId: record.id },
    message: "Locating the owned macOS setup guest.",
  });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]);
  const done = (async () => {
    const host = await waitForGuestAddress(macAddress, signal);
    const connection = {
      host,
      port: 22,
      user: "vectis",
      identityFile: join(record.directory, "guest-key"),
      knownHostsFile: join(record.directory, "known_hosts"),
      hostKeyAlias: record.configuration.id,
    };
    if (command.type === "environment.connect-macos-guest") {
      const access = await prepareMacAccess(
        record.directory,
        record.configuration.id,
        host,
        signal,
      );
      const current = setup(store, record.id);
      if (current.phase !== "setup_running" || current.attemptId !== record.attemptId)
        throw new VectisError(
          "setup_changed",
          "The guest setup session changed. Reopen its console and retry.",
        );
      if (command.openTerminal)
        await runProcess("/usr/bin/open", ["-a", "Terminal", access.path], signal);
      store.update(operation, {
        status: "action_required",
        message: "Dedicated guest SSH enrollment is ready.",
        result: {
          setupId: record.id,
          phase: "ssh_enrollment",
          scriptPath: access.path,
          terminalOpened: command.openTerminal ?? false,
          nextStep:
            "Run the generated connection script on the host, verify the guest host-key fingerprint, and enter the guest vectis password in that Terminal only. Then verify guest access in Vectis. No password goes through the service or cloud.",
        },
      });
      return;
    }
    const result = await executeGuest(
      connection,
      'set -eu\nprintf \'%s %s\\n\' "$(uname -m)" "$(date -u +%s)"\n/usr/bin/fdesetup status\n/usr/bin/sw_vers -productVersion\n' +
        macToolchainProbe,
      { signal },
    );
    if (result.exitCode !== 0)
      throw new VectisError(
        "guest_verification_failed",
        "The guest readiness commands did not complete.",
        "Complete guest SSH enrollment and inspect guest settings before retrying.",
      );
    const toolchain = verifyMacSetupOutput(result.stdout);
    const current = setup(store, record.id);
    if (current.phase !== "setup_running" || current.attemptId !== record.attemptId)
      throw new VectisError(
        "setup_changed",
        "The guest setup session changed during verification.",
      );
    store.put("macInstallation", record.id, { ...current, sshVerifiedAttempt: record.attemptId });
    store.update(operation, {
      status: "action_required",
      message:
        "Guest SSH, macOS version, architecture, clock, FileVault state and developer toolchain verified.",
      result: {
        setupId: record.id,
        phase: "ssh_verified",
        toolchain,
        nextStep:
          "Shut down the guest from its Apple menu, then finish macOS setup in Vectis. The environment is not registered yet.",
      },
    });
  })().catch((error: unknown) => {
    const issue =
      error instanceof VectisError
        ? error
        : new VectisError(
            "guest_setup_failed",
            "Guest access setup could not finish.",
            "Check that the setup console and Remote Login are available, then retry the same setup.",
          );
    store.update(operation, {
      status: signal.aborted ? "cancelled" : "action_required",
      message: issue.message,
      result: { setupId: record.id, code: issue.code, nextStep: issue.nextStep },
    });
  });
  return { abort, done };
}
export async function completedMacEnvironment(store: Store, id: string): Promise<Environment> {
  const record = setup(store, id);
  if (
    record.phase !== "setup_required" ||
    !record.bundle ||
    record.sshVerifiedAttempt !== record.attemptId ||
    !(await preparationStopped(record.directory, record.attemptId))
  )
    throw new VectisError(
      "guest_setup_incomplete",
      "Verify guest SSH and shut down the setup guest before registering it.",
    );
  return {
    id: record.configuration.id,
    name: record.configuration.name,
    os: "macos",
    state: "ready",
    basePath: record.bundle,
    storagePath: record.configuration.storagePath,
    cpu: record.configuration.cpu,
    memoryMiB: record.configuration.memoryMiB,
    sshUser: "vectis",
    sshKeyPath: join(record.directory, "guest-key"),
    knownHostsPath: join(record.directory, "known_hosts"),
  };
}
