#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, platform, arch, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  capabilities,
  Connection,
  Environment,
  VectisError,
  decodeCommand,
  type Command,
} from "../../../packages/protocol/src/index.js";
import { VectisClient } from "../../../packages/client/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    file: { type: "string" },
    key: { type: "string" },
    wait: { type: "boolean" },
    "non-interactive": { type: "boolean" },
    timeout: { type: "string" },
  },
});
const home = values.home ?? process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value, null, values.json ? undefined : 2) + "\n");
async function client() {
  return new VectisClient(
    Schema.decodeUnknownSync(Connection)(
      JSON.parse(await readFile(join(home, "connection.json"), "utf8")),
    ),
  );
}
async function main() {
  const [command = "help", subcommand, id] = positionals;
  if (values.help || command === "help") {
    process.stdout.write(`Vectis - local GitHub Actions runner control

Usage: vectis <command> [options]

  service start                 Start an independent background service
  service run                   Run the service in the foreground
  service stop                  Stop through an authenticated service request
  status                        Inspect the machine and recent operations
  capabilities                  Discover supported commands and schemas
  doctor                        Inspect host and runtime prerequisites
  pause | resume                Control new instance admission
  environment register --file   Register a prepared environment JSON file
  environment start <id>        Start a disposable VM
  environment remove <id>       Remove an idle definition, preserving its disk
  instance stop <id>             Stop an owned VM
  instance reconcile <id>        Recheck an interrupted instance safely
  operation get <id>             Inspect an operation
  operation wait <id>            Wait for an operation's terminal state
  command --file <path>          Submit any protocol command as JSON

Options:
  --home <directory>             Isolated Vectis state directory
  --json                        Machine-readable JSON output
  --key <id>                    Idempotency key for a mutation
  --wait                        Wait for command completion
  --timeout <milliseconds>      Wait timeout (default 120000)
  --non-interactive             Never prompt (all commands are prompt-free)

Examples:
  vectis service start --home /tmp/vectis-demo --json
  vectis status --home /tmp/vectis-demo --json
  vectis environment register --file environment.json --wait --json

Only capabilities reported by this build are supported. Cloud setup and
GitHub pairing require separately configured development services.
`);
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
    output({
      host: {
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        memoryMiB: Math.floor(totalmem() / 1048576),
      },
      supportedHost: platform() === "darwin" && arch() === "arm64",
      configured: {
        appleHelper: Boolean(process.env.VECTIS_APPLE_HELPER),
        qemu: Boolean(process.env.VECTIS_QEMU),
        qemuImg: Boolean(process.env.VECTIS_QEMU_IMG),
      },
      home,
    });
    return;
  }
  if (command === "service" && subcommand === "run") {
    process.env.VECTIS_HOME = home;
    await import("../../server/src/main.js");
    return;
  }
  if (command === "service" && subcommand === "start") {
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
  const api = await client();
  if (command === "service" && subcommand === "stop") {
    const response = await fetch(new URL("/v1/shutdown", api.connection.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${api.connection.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new VectisError("shutdown_failed", "The service did not accept shutdown.");
    output({ stopping: true });
    return;
  }
  if (command === "status") {
    output(await api.status());
    return;
  }
  if (command === "operation") {
    if (!id) throw new VectisError("missing_argument", "An operation ID is required.");
    const operation =
      subcommand === "wait"
        ? await api.wait(id, AbortSignal.timeout(Number(values.timeout ?? 120000)))
        : (await api.status()).operations.find((item) => item.id === id);
    if (!operation) throw new VectisError("operation_missing", "Operation not found.");
    output(operation);
    if (operation.status === "failed") process.exitCode = 1;
    return;
  }
  let request: Command;
  if (command === "pause" || command === "resume")
    request = { type: "machine.pause", paused: command === "pause" };
  else if (command === "environment" && subcommand === "register" && values.file)
    request = {
      type: "environment.register",
      environment: Schema.decodeUnknownSync(Environment)(
        JSON.parse(await readFile(values.file, "utf8")),
      ),
    };
  else if (command === "environment" && (subcommand === "start" || subcommand === "remove") && id)
    request = { type: subcommand === "start" ? "environment.start" : "environment.remove", id };
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
  if (result.status === "failed") process.exitCode = 1;
  if (result.status === "action_required") process.exitCode = 3;
}
main().catch((error) => {
  const issue =
    error instanceof VectisError
      ? error
      : new VectisError(
          "client_error",
          error instanceof Error ? error.message : "The request failed.",
          "Run vectis service start or inspect the selected home.",
        );
  output({ error: { code: issue.code, message: issue.message, nextStep: issue.nextStep } });
  process.exitCode = 1;
});
