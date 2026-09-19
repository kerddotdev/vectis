#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  capabilities,
  Environment,
  VectisError,
  decodeCommand,
  type Command,
} from "../../../packages/protocol/src/index.js";
import { runtimeDiagnostics } from "../../../packages/runner/src/diagnostics.js";
import { githubConnection } from "../../../packages/client/src/github.js";
import { beginPairing, finishPairing } from "../../../packages/client/src/pairing.js";
import {
  beginControllerLogin,
  finishControllerLogin,
  logoutController,
} from "../../../packages/client/src/controller-login.js";
import { controllerClient } from "../../../packages/client/src/controller.js";
import { RemoteClient } from "../../../packages/client/src/remote.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { localClient } from "../../../packages/client/src/local.js";
import { buildInfo } from "../../../packages/client/src/build.js";
import { cloudDeployment, resolveHome } from "../../../packages/client/src/deployment.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      machine: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      file: { type: "string" },
      key: { type: "string" },
      wait: { type: "boolean" },
      "if-idle": { type: "boolean" },
      "non-interactive": { type: "boolean" },
      timeout: { type: "string" },
      cpu: { type: "string" },
      "job-id": { type: "string" },
      account: { type: "string" },
      owner: { type: "string" },
      name: { type: "string" },
      "disk-gib": { type: "string" },
      "image-directory": { type: "string" },
      "restore-path": { type: "string" },
      "open-terminal": { type: "boolean" },
      "iso-path": { type: "string" },
      "drivers-path": { type: "string" },
      "firmware-path": { type: "string" },
      "firmware-vars-path": { type: "string" },
      "image-name": { type: "string" },
      "accept-license": { type: "boolean" },
      environment: { type: "string" },
      "memory-mib": { type: "string" },
      "storage-path": { type: "string" },
    },
  });
  const home = resolveHome(values.home);
  const output = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, values.json ? undefined : 2) + "\n");
  const credentials = () => {
    const helper = process.env.VECTIS_KEYCHAIN_HELPER;
    if (!helper)
      throw new VectisError(
        "setup_required",
        "Remote access requires VECTIS_KEYCHAIN_HELPER.",
        "Configure the native Keychain helper for this CLI.",
      );
    return new KeychainCredentials(helper);
  };
  const client = async () =>
    values.machine
      ? new RemoteClient(await controllerClient(home, credentials()), values.machine)
      : localClient(home);

  const [command = "help", subcommand, id] = positionals;
  if (values.version || command === "version") {
    process.stdout.write(
      values.json ? JSON.stringify(buildInfo()) + "\n" : `${buildInfo().version}\n`,
    );
    return;
  }
  if (values.help || command === "help") {
    process.stdout.write(`Vectis - local GitHub Actions runner control

Usage: vectis <command> [options]

  login [--name <text>]         Begin browser-approved remote control, no local service required
  login finish                  Complete approved remote access using Keychain
  logout                        Revoke this CLI connection and remove local credentials
  machine list                  List owned cloud machines and last-seen presence
  github accounts               List verified accounts available to this paired machine
  repository connect <name>     Connect using --account <id> and --environment <id>, optional --owner <organization>
  github connect                Open the guided GitHub account connection
  cloud pair                    Begin browser-approved machine pairing
  cloud finish                  Complete an approved pairing from Keychain
  service install               Install and start a macOS login service
  service uninstall             Remove login registration, preserving all data
  service update                Adopt this runtime when idle; restore the previous one on failure
  service recover-update        Restore the previous runtime after an interrupted update
  service status                Inspect login registration for this home
  service start                 Start the installed or independent background service
  service run                   Run the service in the foreground
  service stop [--if-idle]      Stop the service; --if-idle refuses to interrupt active work
  migration analyze <binding-id>  Prepare a repository workflow migration preview
  migration publish <preview-id>  Create or recover its PR without merging
  job scan <binding-id>         Discover missing jobs through the GitHub API
  job refresh <binding-id> <job-id>  Recover a job state directly from GitHub
  job list <binding-id>         Read recent GitHub job status for a connected repository
  repository enable-auto <id>   Enable automatic runners for matching queued jobs
  repository disconnect <id>   Stop future runner admission without interrupting running jobs
  repository disable-auto <id>  Disable future automatic runner admission
  repository list               List this machine's connected repositories (requires cloud pairing)
  storage                       Inspect image and VM disk usage
  status                        Inspect the machine and recent operations
  capabilities                  Discover supported commands and schemas
  doctor                        Inspect host and runtime prerequisites
  pause | resume                Control new instance admission
  environment install-macos <id>  Install with --image-directory and --storage-path; optional --restore-path <IPSW>
  environment install-windows <id>  Install ARM64 Windows with --iso-path, --drivers-path, --firmware-path, --firmware-vars-path, --image-directory, --storage-path and --accept-license
  environment resume-windows <setup-id>  Continue an interrupted Windows installation
  environment discard-macos <setup-id> --environment <id>  Permanently discard a stopped unregistered setup
  environment open-macos-setup <setup-id>  Open the local guest setup console
  environment connect-macos-guest <setup-id>  Prepare guest SSH enrollment; optional --open-terminal
  environment verify-macos-guest <setup-id>   Verify guest SSH and unattended startup prerequisites
  environment finish-macos-setup <setup-id>   Register the verified, stopped macOS setup
  environment resume-macos <setup-id>  Inspect or retry an interrupted macOS installation
  environment prepare-linux <id>  Prepare Ubuntu with --image-directory and --storage-path
  environment resume <setup-id>   Continue an interrupted image preparation
  environment register --file   Register a prepared environment JSON file
  environment configure <id>    Set --cpu, --memory-mib or --storage-path for future VMs
  environment start <id>        Start a VM; optionally override --cpu, --memory-mib, --storage-path
  environment remove <id>       Remove an idle definition, preserving its disk
  instance stop <id>             Stop an owned VM
  instance reconcile <id>        Recheck an interrupted instance safely
  runner run <binding-id>        Start one disposable runner (requires a prepared connected environment)
  runner reconcile <operation-id>  Clean an interrupted runner after verifying its VM stopped
  operation cancel <id>          Request runner cancellation and cleanup
  operation get <id>             Inspect an operation
  operation wait <id>            Wait for an operation's terminal state
  command --file <path>          Submit any protocol command as JSON

Options:
  --home <directory>             Isolated Vectis state directory
  --machine <id>                 Send mutations and operation get/wait to this remote machine
  --json                        Machine-readable JSON output
  -v, --version                 Print the Vectis version
  --name <text>                Prepared environment display name (default: Ubuntu 24.04 ARM64)
  --image-directory <path>      Existing directory for prepared base images
  --disk-gib <GiB>              Prepared Linux virtual capacity (default: 32)
  --job-id <number>             Require a matching queued GitHub job before runner admission
  --key <id>                    Idempotency key for a mutation
  --wait                        Wait for command completion
  --timeout <milliseconds>      Wait timeout (default 120000)
  --non-interactive             Never prompt (all commands are prompt-free)

Examples:
  vectis service start --home /tmp/vectis-demo --json
  vectis status --home /tmp/vectis-demo --json
  vectis environment register --file environment.json --wait --json
  vectis repository list --json
  vectis runner run <binding-id> --key <stable-key> --json
  vectis operation wait <operation-id> --timeout 3600000 --json

Only capabilities reported by this build are supported. Cloud setup and
GitHub pairing require separately configured development services.
`);
    return;
  }
  if (values.machine && ["service", "cloud", "login", "logout", "machine"].includes(command))
    throw new VectisError("invalid_target", "This command does not accept --machine.");
  if (
    command === "login" ||
    command === "logout" ||
    (command === "machine" && subcommand === "list")
  ) {
    const store = credentials();
    const result =
      command === "logout"
        ? await logoutController(home, store)
        : command === "machine"
          ? await (await controllerClient(home, store)).request({ type: "machines.list" })
          : subcommand === "finish"
            ? await finishControllerLogin(home, store)
            : subcommand === undefined
              ? await beginControllerLogin(
                  home,
                  cloudDeployment(),
                  values.name ?? "Vectis CLI",
                  store,
                )
              : (() => {
                  throw new VectisError("unknown_command", "Use login or login finish.");
                })();
    output(result);
    if (
      result &&
      typeof result === "object" &&
      "state" in result &&
      ["action_required", "pending"].includes(String(result.state))
    )
      process.exitCode = 3;
    return;
  }
  if (command === "github" && subcommand === "connect") {
    output(githubConnection(cloudDeployment()));
    process.exitCode = 3;
    return;
  }
  if (command === "cloud" && (subcommand === "pair" || subcommand === "finish")) {
    const helper = process.env.VECTIS_KEYCHAIN_HELPER;
    if (!helper)
      throw new VectisError(
        "setup_required",
        "Pairing requires VECTIS_KEYCHAIN_HELPER.",
        "Build the native Keychain helper and configure its absolute path before starting the service and CLI.",
      );
    const credentials = new KeychainCredentials(helper);
    const result =
      subcommand === "pair"
        ? await beginPairing(home, cloudDeployment(), credentials)
        : await finishPairing(home, credentials);
    output(result);
    if (result.state === "action_required" || result.state === "pending") process.exitCode = 3;
    return;
  }
  if (command === "capabilities") {
    if (values.machine) {
      output(await (await client()).capabilities());
      return;
    }
    output({
      protocolVersion: 1,
      capabilities,
      commandSchema: Schema.toJsonSchemaDocument(
        (await import("../../../packages/protocol/src/index.js")).Command,
      ),
    });
    return;
  }
  if (command === "doctor") {
    if (values.machine) {
      output(await (await client()).doctor());
      return;
    }
    try {
      output(await (await localClient(home)).doctor());
    } catch {
      output(
        runtimeDiagnostics(
          {
            home,
            ...(process.env.VECTIS_APPLE_HELPER
              ? { appleHelper: process.env.VECTIS_APPLE_HELPER }
              : {}),
            ...(process.env.VECTIS_QEMU ? { qemu: process.env.VECTIS_QEMU } : {}),
            ...(process.env.VECTIS_QEMU_IMG ? { qemuImg: process.env.VECTIS_QEMU_IMG } : {}),
            ...(process.env.VECTIS_SWTPM ? { swtpm: process.env.VECTIS_SWTPM } : {}),
            ...(process.env.VECTIS_KEYCHAIN_HELPER
              ? { keychainHelper: process.env.VECTIS_KEYCHAIN_HELPER }
              : {}),
          },
          "shell",
        ),
      );
    }
    return;
  }

  if (
    command === "service" &&
    (subcommand === "install" ||
      subcommand === "uninstall" ||
      subcommand === "status" ||
      subcommand === "update" ||
      subcommand === "recover-update")
  ) {
    const agent = await LaunchAgent.forHome(home);
    output(await agent[subcommand === "recover-update" ? "recoverUpdate" : subcommand]());
    return;
  }
  if (command === "service" && subcommand === "run") {
    process.env.VECTIS_HOME = home;
    await import("../../server/src/main.js");
    return;
  }
  if (command === "service" && subcommand === "start") {
    if (platform() === "darwin") {
      const agent = await LaunchAgent.forHome(home);
      if (await agent.installed()) {
        output(await agent.start());
        return;
      }
    }
    try {
      const existing = await client();
      await existing.status();
      output({ running: true, home });
      return;
    } catch {
      /* The service acquires its own exclusive lock. */
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    const log = await open(join(home, "service.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../server/src/main.js", import.meta.url))],
      {
        env: { ...process.env, VECTIS_HOME: home },
        detached: true,
        stdio: ["ignore", "pipe", log.fd],
      },
    );
    await log.close();
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new VectisError("startup_timeout", "Service readiness was not observed."));
      }, 15000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(
          new VectisError(
            "startup_failed",
            "The service exited before readiness.",
            "Inspect service.log in the selected home.",
          ),
        );
      });
      child.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          child.stdout?.destroy();
          child.unref();
          output({ running: true, pid: child.pid, home });
          resolve();
        }
      });
    });
    return;
  }
  if (
    values.timeout !== undefined &&
    (!Number.isSafeInteger(Number(values.timeout)) ||
      Number(values.timeout) < 1 ||
      Number(values.timeout) > 2147483647)
  )
    throw new VectisError(
      "invalid_timeout",
      "Timeout must be a positive integer below 2147483648 milliseconds.",
    );
  if (
    command === "operation" &&
    subcommand !== "get" &&
    subcommand !== "wait" &&
    subcommand !== "cancel"
  )
    throw new VectisError("unknown_command", "Use operation get, wait or cancel.");
  const api = await client();
  if (command === "service" && subcommand === "stop") {
    await api.shutdown({ ifIdle: values["if-idle"] ?? false });
    output({ stopping: true });
    return;
  }
  if (command === "github" && subcommand === "accounts") {
    output(await api.githubAccounts());
    return;
  }
  if (command === "job" && subcommand === "list" && id) {
    output(await api.jobs(id));
    return;
  }
  if (command === "repository" && subcommand === "list") {
    output(await api.repositories());
    return;
  }
  if (command === "storage") {
    output(await api.storage());
    return;
  }
  if (command === "status") {
    output(await api.status());
    return;
  }
  if (command === "operation" && subcommand !== "cancel") {
    if (!id) throw new VectisError("missing_argument", "An operation ID is required.");
    const operation =
      subcommand === "wait"
        ? await api.wait(id, AbortSignal.timeout(Number(values.timeout ?? 120000)))
        : await api.operation(id);
    if (!operation) throw new VectisError("operation_missing", "Operation not found.");
    output(operation);
    if (operation.status === "failed" || operation.status === "cancelled") process.exitCode = 1;
    if (operation.status === "action_required") process.exitCode = 3;
    return;
  }
  let request: Command;
  if (command === "pause" || command === "resume")
    request = { type: "machine.pause", paused: command === "pause" };
  else if (
    command === "repository" &&
    (subcommand === "enable-auto" || subcommand === "disable-auto") &&
    id
  )
    request = decodeCommand({
      type: "repository.automatic",
      bindingId: id,
      enabled: subcommand === "enable-auto",
    });
  else if (command === "migration" && subcommand === "analyze" && id)
    request = decodeCommand({ type: "migration.analyze", bindingId: id });
  else if (command === "migration" && subcommand === "publish" && id)
    request = decodeCommand({ type: "migration.publish", previewId: id });
  else if (command === "job" && subcommand === "scan" && id)
    request = decodeCommand({ type: "job.scan", bindingId: id });
  else if (command === "job" && subcommand === "refresh" && id && positionals[3])
    request = decodeCommand({ type: "job.refresh", bindingId: id, jobId: Number(positionals[3]) });
  else if (command === "runner" && subcommand === "reconcile" && id)
    request = decodeCommand({ type: "runner.reconcile", id });
  else if (command === "runner" && subcommand === "run" && id)
    request = decodeCommand({
      type: "runner.run",
      bindingId: id,
      ...(values["job-id"] === undefined ? {} : { jobId: Number(values["job-id"]) }),
    });
  else if (command === "operation" && subcommand === "cancel" && id)
    request = decodeCommand({ type: "operation.cancel", id });
  else if (
    command === "repository" &&
    subcommand === "connect" &&
    id &&
    values.account &&
    values.environment
  )
    request = decodeCommand({
      type: "repository.connect",
      accountId: values.account,
      repositoryName: id,
      ...(values.owner ? { repositoryOwner: values.owner } : {}),
      environmentId: values.environment,
    });
  else if (command === "repository" && subcommand === "disconnect" && id)
    request = decodeCommand({ type: "repository.disconnect", bindingId: id });
  else if (command === "environment" && subcommand === "install-macos" && id)
    request = decodeCommand({
      type: "environment.install-macos",
      id,
      name: values.name ?? "macOS 26 ARM64",
      restorePath: values["restore-path"],
      imageDirectory: values["image-directory"],
      storagePath: values["storage-path"],
      cpu: Number(values.cpu ?? 2),
      memoryMiB: Number(values["memory-mib"] ?? 4096),
      diskGiB: Number(values["disk-gib"] ?? 64),
    });
  else if (command === "environment" && subcommand === "install-windows" && id)
    request = decodeCommand({
      type: "environment.install-windows",
      id,
      name: values.name ?? "Windows 11 ARM64",
      isoPath: values["iso-path"],
      driversPath: values["drivers-path"],
      firmwarePath: values["firmware-path"],
      firmwareVarsPath: values["firmware-vars-path"],
      imageName: values["image-name"] ?? "Windows 11 Pro",
      acceptLicense: values["accept-license"] ?? false,
      imageDirectory: values["image-directory"],
      storagePath: values["storage-path"],
      cpu: Number(values.cpu ?? 4),
      memoryMiB: Number(values["memory-mib"] ?? 8192),
      diskGiB: Number(values["disk-gib"] ?? 96),
    });
  else if (command === "environment" && subcommand === "resume-windows" && id)
    request = decodeCommand({ type: "environment.resume-windows", id });
  else if (command === "environment" && subcommand === "discard-macos" && id && values.environment)
    request = decodeCommand({
      type: "environment.discard-macos",
      id,
      environmentId: values.environment,
    });
  else if (command === "environment" && subcommand === "open-macos-setup" && id)
    request = decodeCommand({ type: "environment.open-macos-setup", id });
  else if (command === "environment" && subcommand === "connect-macos-guest" && id)
    request = decodeCommand({
      type: "environment.connect-macos-guest",
      id,
      openTerminal: values["open-terminal"] ?? false,
    });
  else if (command === "environment" && subcommand === "verify-macos-guest" && id)
    request = decodeCommand({ type: "environment.verify-macos-guest", id });
  else if (command === "environment" && subcommand === "finish-macos-setup" && id)
    request = decodeCommand({ type: "environment.finish-macos-setup", id });
  else if (command === "environment" && subcommand === "resume-macos" && id)
    request = decodeCommand({ type: "environment.resume-macos", id });
  else if (command === "environment" && subcommand === "prepare-linux" && id)
    request = decodeCommand({
      type: "environment.prepare-linux",
      id,
      name: values.name ?? "Ubuntu 24.04 ARM64",
      imageDirectory: values["image-directory"],
      storagePath: values["storage-path"],
      cpu: Number(values.cpu ?? 2),
      memoryMiB: Number(values["memory-mib"] ?? 4096),
      diskGiB: Number(values["disk-gib"] ?? 32),
    });
  else if (command === "environment" && subcommand === "resume" && id)
    request = decodeCommand({ type: "environment.resume", id });
  else if (command === "environment" && subcommand === "register" && values.file)
    request = {
      type: "environment.register",
      environment: Schema.decodeUnknownSync(Environment)(
        JSON.parse(await readFile(values.file, "utf8")),
      ),
    };
  else if (command === "environment" && subcommand === "configure" && id)
    request = decodeCommand({
      type: "environment.configure",
      id,
      ...(values.cpu !== undefined ? { cpu: Number(values.cpu) } : {}),
      ...(values["memory-mib"] !== undefined ? { memoryMiB: Number(values["memory-mib"]) } : {}),
      ...(values["storage-path"] !== undefined ? { storagePath: values["storage-path"] } : {}),
    });
  else if (command === "environment" && subcommand === "start" && id)
    request = decodeCommand({
      type: "environment.start",
      id,
      ...(values.cpu !== undefined ? { cpu: Number(values.cpu) } : {}),
      ...(values["memory-mib"] !== undefined ? { memoryMiB: Number(values["memory-mib"]) } : {}),
      ...(values["storage-path"] !== undefined ? { storagePath: values["storage-path"] } : {}),
    });
  else if (command === "environment" && subcommand === "remove" && id)
    request = { type: "environment.remove", id };
  else if (command === "instance" && (subcommand === "stop" || subcommand === "reconcile") && id)
    request = { type: subcommand === "stop" ? "instance.stop" : "instance.reconcile", id };
  else if (command === "command" && values.file)
    request = decodeCommand(JSON.parse(await readFile(values.file, "utf8")));
  else
    throw new VectisError(
      "unknown_command",
      "Unknown command or missing argument.",
      "Run vectis --help.",
    );
  const accepted = await api.submit(request, values.key ?? randomUUID());
  const result = values.wait
    ? await api.wait(accepted.id, AbortSignal.timeout(Number(values.timeout ?? 120000)))
    : accepted;
  output(result);
  if (result.status === "failed" || result.status === "cancelled") process.exitCode = 1;
  if (result.status === "action_required") process.exitCode = 3;
}
main().catch((error) => {
  const issue =
    error instanceof VectisError
      ? error
      : new VectisError(
          error instanceof Error &&
            "code" in error &&
            String(error.code).startsWith("ERR_PARSE_ARGS")
            ? "invalid_arguments"
            : "client_error",
          error instanceof Error ? error.message : "The request failed.",
          "Inspect the command input and run vectis --help.",
        );
  process.stdout.write(
    JSON.stringify({
      error: { code: issue.code, message: issue.message, nextStep: issue.nextStep },
    }) + "\n",
  );
  process.exitCode = 1;
});
