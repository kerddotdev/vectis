#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
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
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { localClient } from "../../../packages/client/src/local.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      url: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      file: { type: "string" },
      key: { type: "string" },
      wait: { type: "boolean" },
      "non-interactive": { type: "boolean" },
      timeout: { type: "string" },
      cpu: { type: "string" },
      "job-id": { type: "string" },
      "memory-mib": { type: "string" },
      "storage-path": { type: "string" },
    },
  });
  const home = values.home ?? process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
  const output = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, values.json ? undefined : 2) + "\n");
  const client = () => localClient(home);

  const [command = "help", subcommand, id] = positionals;
  if (values.help || command === "help") {
    process.stdout.write(`Vectis - local GitHub Actions runner control

Usage: vectis <command> [options]

  github connect                Open the guided GitHub account connection
  cloud pair [--url <deployment>]  Begin browser-approved machine pairing
  cloud finish                  Complete an approved pairing from Keychain
  service install               Install and start a macOS login service
  service uninstall             Remove login registration, preserving all data
  service status                Inspect login registration for this home
  service start                 Start the installed or independent background service
  service run                   Run the service in the foreground
  service stop                  Stop through an authenticated service request
  job refresh <binding-id> <job-id>  Recover a job state directly from GitHub
  job list <binding-id>         Read recent GitHub job status for a connected repository
  repository enable-auto <id>   Enable automatic runners for matching queued jobs
  repository disable-auto <id>  Disable future automatic runner admission
  repository list               List this machine's connected repositories (requires cloud pairing)
  storage                       Inspect image and VM disk usage
  status                        Inspect the machine and recent operations
  capabilities                  Discover supported commands and schemas
  doctor                        Inspect host and runtime prerequisites
  pause | resume                Control new instance admission
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
  --json                        Machine-readable JSON output
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
  if (command === "github" && subcommand === "connect") {
    output(githubConnection());
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
        ? await beginPairing(home, values.url ?? "https://clear-hare-471.convex.cloud", credentials)
        : await finishPairing(home, credentials);
    output(result);
    if (result.state === "action_required" || result.state === "pending") process.exitCode = 3;
    return;
  }
  if (command === "capabilities") {
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
    (subcommand === "install" || subcommand === "uninstall" || subcommand === "status")
  ) {
    const agent = await LaunchAgent.forHome(home);
    output(await agent[subcommand]());
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
    await api.shutdown();
    output({ stopping: true });
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
        : (await api.status()).operations.find((item) => item.id === id);
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
