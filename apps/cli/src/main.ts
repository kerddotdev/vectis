#!/usr/bin/env node
import { RepositoryReadinessInput } from "../../../packages/protocol/src/readiness.js";
import { setTimeout as delay } from "node:timers/promises";
import { JobLogRequest } from "../../../packages/protocol/src/jobs.js";
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
  commandActivity,
  Environment,
  VectisError,
  decodeCommand,
  type Command,
} from "../../../packages/protocol/src/index.js";
import { runtimeDiagnostics } from "../../../packages/runner/src/diagnostics.js";
import { githubConnection } from "../../../packages/client/src/github.js";
import {
  beginPairing,
  disconnectPairing,
  finishPairing,
} from "../../../packages/client/src/pairing.js";
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
      x64: { type: "string" },
      egress: { type: "string" },
      "max-runners": { type: "string" },
      "memory-budget-mib": { type: "string" },
      "warm-pool": { type: "string" },
      "job-id": { type: "string" },
      ref: { type: "string" },
      input: { type: "string", multiple: true },
      actors: { type: "string" },
      approval: { type: "string" },
      "size-gib": { type: "string" },
      account: { type: "string" },
      binding: { type: "string" },
      owner: { type: "string" },
      name: { type: "string" },
      "disk-gib": { type: "string" },
      "image-directory": { type: "string" },
      from: { type: "string" },
      "setup-script": { type: "string" },
      "no-runner": { type: "boolean" },
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
      map: { type: "string", multiple: true },
      follow: { type: "boolean" },
      lines: { type: "string" },
      limit: { type: "string" },
      kind: { type: "string" },
      status: { type: "string" },
      repository: { type: "string" },
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
    process.stdout.write(`Vectis - GitHub Actions runners in disposable VMs on your Mac

Usage: vectis <command> [options]

Service
  service install               Install and start the macOS login service for this home
  service uninstall             Remove the login service, preserving all data
  service start                 Start the installed or an independent background service
  service run                   Run the service in the foreground
  service stop [--if-idle]      Stop the service; --if-idle refuses to interrupt active work
  service status                Inspect the login service registration for this home
  service update                Adopt this runtime when idle; restore the previous one on failure
  service recover-update        Restore the previous runtime after an interrupted update
  status                        Inspect the machine, unfinished work and bounded recent history
  storage                       Inspect image and VM disk usage
  doctor                        Inspect host and runtime prerequisites
  logs [--lines <count>]        Read the newest service log lines (default 200, at most 1000)
  capabilities                  List supported commands and queries with the command schema
  pause | resume                Stop or allow admission of new VMs

Cloud and GitHub
  cloud pair                    Begin browser-approved pairing of this machine with your account
  cloud finish                  Complete an approved pairing
  cloud disconnect              Remove this machine's saved cloud connection and credential
  github connect                Print the page that links a GitHub account and installs the App
  github accounts               List verified GitHub accounts available to this machine
  login [--name <text>]         Begin browser-approved remote control of your machines
  login finish                  Complete an approved remote control login
  logout                        Revoke this CLI's remote access and remove its credentials
  machine list                  List your machines and when they were last seen
  machine configure [--max-runners <N>] [--memory-budget-mib <N>]
                                Set runner limit (1-16, default 5) and shared VM memory budget
                                Memory budget: 2048 MiB to host RAM, default 75% of host RAM

Repositories and jobs
  repository readiness <owner/name> [--environment <id>]  Check readiness before connecting
  repository readiness --binding <id>                     Check an existing binding
  repository list               List repositories connected to this machine, with their runs-on label
  repository connect <name>     Connect with --account <id> and --environment <id>, optional --owner <org>
  repository enable-auto <id>   Start runners automatically for matching queued jobs
  repository disable-auto <id>  Stop starting runners automatically
  repository capacity-mode <id> demand|scale-set  Choose runner capacity mode (scale sets are preview)
  repository disconnect <id>    Stop future runners without interrupting running jobs
  runner run <binding-id>       Start one disposable runner, optionally only for --job-id <id>
  runner reconcile <operation-id>  Clean up an interrupted runner after verifying its VM stopped
  repository cache enable|disable|clear <binding-id> [--size-gib N]
                               Configure or clear an opt-in repository cache disk (default 20 GiB)
  repository access <binding-id> --actors any|<id,id,...> --approval automatic|required
                               Actor IDs are numeric GitHub user IDs: gh api users/<login> --jq .id
  job list <binding-id>         Read recent GitHub job states for a connected repository
  job logs <job-id> --binding <id> [--follow]  Read the retained log; follow backs off from 2 to 30 seconds when empty
  job scan <binding-id>         Discover missing jobs through the GitHub API
  job refresh <binding-id> <job-id>  Recover one job state directly from GitHub

Workflow run control
  run rerun-failed <binding-id> <run-id>  Rerun failed jobs of a completed GitHub run
  run cancel <binding-id> <run-id>  Request cancellation of an active GitHub run
  workflow dispatch <binding-id> <workflow> --ref <ref>  Dispatch a workflow file or numeric ID
  Successful rerun/cancel results distinguish requested from observed GitHub state.
  Ambiguous POST responses require checking GitHub before retrying with a new key.
  Run command receipts expire after 30 days; do not replay older keys.

Workflow migration
  migration preview <workflow-file> --map <from>=<to>  Rewrite runs-on labels locally without writing files
  migration analyze <binding-id>  Prepare a reviewable migration preview for a repository
  migration publish <preview-id>  Create or recover its pull request; never merges

Environments
  environment provision <id>   Derive a new image with --from <id> --image-directory <new-path>
                               [--name <name>] [--setup-script <file>] [--no-runner]
  environment prepare-linux <id>  Prepare Ubuntu 24.04 with --image-directory and --storage-path
  environment resume <setup-id>   Continue an interrupted Ubuntu preparation
  environment install-macos <id>  Install macOS 27 with --image-directory and --storage-path, optional --restore-path
  environment open-macos-setup <setup-id>     Open the guest console for Setup Assistant
  environment connect-macos-guest <setup-id>  Prepare guest SSH enrollment, optional --open-terminal
  environment verify-macos-guest <setup-id>   Verify guest SSH and unattended startup prerequisites
  environment finish-macos-setup <setup-id>   Register the verified, stopped macOS setup
  environment resume-macos <setup-id>         Inspect or retry an interrupted macOS installation
  environment discard-macos <setup-id> --environment <id>  Permanently discard an unregistered setup
  environment install-windows <id>  Experimental: install Windows 11 from your ISO, drivers and firmware
  environment resume-windows <setup-id>  Continue an interrupted Windows installation
  environment register --file <path>  Register an existing prepared environment JSON file
  environment list              List environments and effective network egress
  environment configure <id>    Set --cpu, --memory-mib, --storage-path, --x64 rosetta|off or --egress internet_only|open for future VMs
                                --warm-pool <N> keeps 0-4 SSH-ready VMs (default 0, uses RAM)
  environment start <id>        Start a clean VM, optionally overriding --cpu, --memory-mib, --storage-path
  environment remove <id>       Remove an idle definition, preserving its disk
  instance stop <id>            Stop a VM owned by this service
  instance reconcile <id>       Recheck an interrupted VM safely

Activities and operations
  activity list                 List unfinished and recent activities; filter with --kind, --status, --repository, --limit
  activity get <id>             Inspect one activity with the operations that belong to it
  activity cancel <id>          Cancel work an activity owns, or close one that only waits for you
  operation get <id>            Inspect one retained operation, including outside the status window
  operation wait <id>           Wait for an operation's terminal state; on --timeout, print it as it is
  operation cancel <id>         Cancel an active operation, or close one that only waits for you
  command --file <path>         Submit any protocol command as JSON
  version                       Print the Vectis version

Options
  --home <directory>            State directory (default: ~/.vectis, or ~/.vectis-dev for development builds)
  --machine <id>                Send commands and queries to a remote machine after vectis login
  --json                        Print compact JSON (output is always JSON)
  --key <id>                    Idempotency key; retrying with the same key never repeats work
  --kind <vectis|github>        Filter activities by what asked for them
  --status <status>             Filter activities by status
  --repository <owner/name>     Filter activities by repository
  --wait                        Wait for the operation's terminal state (automatic for setting commands)
  --timeout <milliseconds>      Wait timeout (default: 120000)
  --name <text>                 Environment or login name (defaults: Ubuntu 24.04 ARM64, macOS 27 ARM64,
                                Windows 11 ARM64, Vectis CLI)
  --image-directory <path>      Existing directory for prepared base images
  --storage-path <path>         Directory for VM clones
  --cpu <count>                 Virtual CPUs (defaults: 2, Windows 4)
  --memory-mib <MiB>            Memory (defaults: 4096, Windows 8192; at most 75% of host memory)
  --disk-gib <GiB>              Disk capacity (defaults: Ubuntu 32, macOS 64, Windows 96)
  --restore-path <file.ipsw>    Local macOS restore image instead of the pinned download
  --open-terminal               Open Terminal with the guest enrollment script
  --iso-path, --drivers-path, --firmware-path, --firmware-vars-path <path>  Windows installation media
  --image-name <text>           Windows edition in the ISO (default: Windows 11 Pro)
  --accept-license              Accept the Windows license terms for this installation
  --account <id>                GitHub account ID from vectis github accounts
  --owner <organization>        Repository owner when it differs from the account
  --environment <id>            Environment ID
  --job-id <number>             Require a matching queued GitHub job before starting a runner
  --ref <branch-or-tag>         Git ref for workflow dispatch
  --input <key>=<value>         Workflow input; repeat for up to 25 inputs
  --map <from>=<to>             Label mapping for migration preview; repeat for more labels
  --file <path>                 JSON input file
  --if-idle                     Refuse to stop while VMs or operations are active
  -v, --version                 Print the Vectis version
  -h, --help                    Show this help

Exit codes: 0 success, 1 failure or cancellation, 3 action required or still pending.
Setting commands always wait: pause/resume, repository enable-auto/disable-auto/capacity-mode, repository cache,
environment register/configure/remove, instance stop/reconcile, operation cancel, and activity cancel.
Their wait timeout reports wait_cancelled with exit code 3; the operation may still be running.
Errors are JSON: {"error":{"code","message","nextStep"}}.

Examples
  vectis status --json
  vectis environment prepare-linux ubuntu --image-directory ~/VMs/images --storage-path ~/VMs/clones --wait
  vectis repository list --json
  vectis runner run <binding-id> --key <stable-key> --json
  vectis operation wait <operation-id> --timeout 3600000 --json

Documentation: https://vectis.kerd.dev/docs
`);
    return;
  }
  if (values.egress !== undefined && !(command === "environment" && subcommand === "configure"))
    throw new VectisError(
      "invalid_arguments",
      "--egress is supported only by environment configure.",
    );
  if (
    values["warm-pool"] !== undefined &&
    !(command === "environment" && subcommand === "configure")
  )
    throw new VectisError(
      "invalid_arguments",
      "--warm-pool is supported only by environment configure.",
    );
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
  if (
    command === "cloud" &&
    (subcommand === "pair" || subcommand === "finish" || subcommand === "disconnect")
  ) {
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
        : subcommand === "finish"
          ? await finishPairing(home, credentials)
          : await disconnectPairing(home, credentials);
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
  // A wait that runs out of time reports the operation as it is now, with exit code 3.
  const waitFor = async (id: string) => {
    try {
      return await api.wait(id, AbortSignal.timeout(Number(values.timeout ?? 120000)));
    } catch (error) {
      if (error instanceof VectisError && error.code === "wait_cancelled") return api.operation(id);
      throw error;
    }
  };
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
  if (command === "repository" && subcommand === "readiness") {
    if ((values.binding && (id || values.environment)) || (!values.binding && !id))
      throw new VectisError(
        "invalid_arguments",
        "Use repository readiness <owner/name> [--environment <id>] or repository readiness --binding <id>.",
      );
    const input = Schema.decodeUnknownSync(RepositoryReadinessInput)(
      values.binding
        ? { bindingId: values.binding }
        : {
            repositoryName: id,
            ...(values.environment ? { environmentId: values.environment } : {}),
          },
    );
    output(await api.repositoryReadiness(input));
    return;
  }
  if (command === "job" && subcommand === "logs") {
    const input = { bindingId: values.binding, jobId: Number(id) };
    if (!Schema.is(JobLogRequest)(input))
      throw new VectisError(
        "invalid_argument",
        "Use job logs <job-id> --binding <binding-id> with a positive whole job ID.",
      );
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let after: number | undefined;
    let pollDelay = 2000;
    try {
      while (!abort.signal.aborted) {
        const log = await api.jobLogs(
          { ...input, ...(after === undefined ? {} : { after }) },
          abort.signal,
        );
        if (values.json) output(log);
        else process.stdout.write(log.text);
        if (log.truncated)
          process.stderr.write("Earlier job log content was skipped (4 MiB retained window).\n");
        after = log.next;
        if (log.complete) break;
        if (!log.text && !values.follow) break;
        if (values.follow) {
          if (log.text) pollDelay = 2000;
          await delay(pollDelay, undefined, { signal: abort.signal });
          if (!log.text) pollDelay = Math.min(pollDelay * 2, 30000);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
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
  if (command === "environment" && subcommand === "list") {
    output((await api.status()).environments);
    return;
  }
  if (command === "activity" && subcommand === "list") {
    const limit = values.limit === undefined ? 50 : Number(values.limit);
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new VectisError("invalid_argument", "--limit expects a positive whole number.");
    output(
      (await api.activities())
        .filter((activity) => !values.kind || activity.kind === values.kind)
        .filter((activity) => !values.status || activity.status === values.status)
        .filter((activity) => !values.repository || activity.repository?.name === values.repository)
        .slice(0, limit),
    );
    return;
  }
  if (command === "activity" && subcommand === "get") {
    if (!id) throw new VectisError("missing_argument", "An activity ID is required.");
    const { activity, operations } = await api.activity(id);
    output({ activity, operations });
    if (activity.status === "failed" || activity.status === "cancelled") process.exitCode = 1;
    if (["action_required", "accepted", "running"].includes(activity.status)) process.exitCode = 3;
    return;
  }
  if (command === "operation" && subcommand !== "cancel") {
    if (!id) throw new VectisError("missing_argument", "An operation ID is required.");
    const operation = subcommand === "wait" ? await waitFor(id) : await api.operation(id);
    if (!operation) throw new VectisError("operation_missing", "Operation not found.");
    output(operation);
    if (operation.status === "failed" || operation.status === "cancelled") process.exitCode = 1;
    if (["action_required", "accepted", "running"].includes(operation.status)) process.exitCode = 3;
    return;
  }
  if (command === "logs") {
    output(await api.logs(values.lines === undefined ? undefined : Number(values.lines)));
    return;
  }
  let request: Command;
  if (command === "pause" || command === "resume")
    request = { type: "machine.pause", paused: command === "pause" };
  else if (command === "machine" && subcommand === "configure") {
    if (values["max-runners"] === undefined && values["memory-budget-mib"] === undefined)
      throw new VectisError("missing_argument", "Specify --max-runners or --memory-budget-mib.");
    request = decodeCommand({
      type: "machine.configure",
      ...(values["max-runners"] !== undefined ? { maxRunners: Number(values["max-runners"]) } : {}),
      ...(values["memory-budget-mib"] !== undefined
        ? { memoryBudgetMiB: Number(values["memory-budget-mib"]) }
        : {}),
    });
  } else if (
    command === "repository" &&
    (subcommand === "enable-auto" || subcommand === "disable-auto") &&
    id
  )
    request = decodeCommand({
      type: "repository.automatic",
      bindingId: id,
      enabled: subcommand === "enable-auto",
    });
  else if (command === "repository" && subcommand === "cache" && positionals[3]) {
    const bindingId = positionals[3];
    if (id === "clear" && values["size-gib"] === undefined)
      request = decodeCommand({ type: "cache.clear", bindingId });
    else if (id === "enable" || (id === "disable" && values["size-gib"] === undefined))
      request = decodeCommand({
        type: "repository.cache",
        bindingId,
        enabled: id === "enable",
        ...(values["size-gib"] === undefined ? {} : { sizeGiB: Number(values["size-gib"]) }),
      });
    else
      throw new VectisError(
        "invalid_cache_command",
        "Use repository cache enable|disable|clear <binding-id>; --size-gib is only valid with enable.",
      );
  } else if (command === "repository" && subcommand === "capacity-mode" && id) {
    const mode = positionals[3];
    if (positionals.length !== 4 || (mode !== "demand" && mode !== "scale-set"))
      throw new VectisError(
        "invalid_capacity_mode",
        "Use repository capacity-mode <binding-id> demand|scale-set.",
      );
    request = decodeCommand({
      type: "repository.capacity-mode",
      bindingId: id,
      mode: mode === "scale-set" ? "scale_set" : "demand",
    });
  } else if (command === "repository" && subcommand === "access" && id) {
    if (
      !values.actors ||
      (values.actors !== "any" && !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(values.actors))
    )
      throw new VectisError(
        "invalid_repository_access",
        "Use any or comma-separated numeric GitHub user IDs.",
      );
    request = decodeCommand({
      type: "repository.access",
      bindingId: id,
      actors:
        values.actors === "any"
          ? "any"
          : { ids: [...new Set(values.actors.split(",").map(Number))] },
      approval: values.approval,
    });
  } else if (command === "migration" && subcommand === "analyze" && id)
    request = decodeCommand({ type: "migration.analyze", bindingId: id });
  else if (command === "migration" && subcommand === "preview" && id)
    request = decodeCommand({
      type: "migration.preview",
      source: await readFile(id, "utf8"),
      targets: (values.map ?? []).map((mapping) => {
        const [from, to, ...rest] = mapping.split("=");
        if (!from || !to || rest.length)
          throw new VectisError("invalid_arguments", "Use --map <from-label>=<vectis-label>.");
        return { from, to };
      }),
    });
  else if (command === "migration" && subcommand === "publish" && id)
    request = decodeCommand({ type: "migration.publish", previewId: id });
  else if (
    command === "run" &&
    (subcommand === "rerun-failed" || subcommand === "cancel") &&
    id &&
    positionals[3]
  )
    request = decodeCommand({
      type: subcommand === "cancel" ? "run.cancel" : "run.rerun-failed",
      bindingId: id,
      runId: Number(positionals[3]),
    });
  else if (command === "workflow" && subcommand === "dispatch" && id && positionals[3]) {
    const inputs = new Map<string, string>();
    for (const input of values.input ?? []) {
      const separator = input.indexOf("=");
      const key = input.slice(0, separator);
      if (separator < 1 || inputs.has(key))
        throw new VectisError("invalid_arguments", "Use distinct --input <key>=<value> arguments.");
      inputs.set(key, input.slice(separator + 1));
    }
    const workflow = positionals[3];
    request = decodeCommand({
      type: "workflow.dispatch",
      bindingId: id,
      workflow: /^\d+$/.test(workflow) ? Number(workflow) : workflow,
      ref: values.ref,
      ...(values.input === undefined ? {} : { inputs: Object.fromEntries(inputs) }),
    });
  } else if (command === "job" && subcommand === "scan" && id)
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
  else if (command === "activity" && subcommand === "cancel" && id)
    request = decodeCommand({ type: "activity.cancel", id });
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
      name: values.name ?? "macOS 27 ARM64",
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
  else if (command === "environment" && subcommand === "provision" && id)
    request = decodeCommand({
      type: "environment.provision",
      id,
      from: values.from,
      imageDirectory: values["image-directory"],
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values["setup-script"] !== undefined
        ? { setupScript: await readFile(values["setup-script"], "utf8") }
        : {}),
      ...(values["no-runner"] ? { runner: false } : {}),
    });
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
      ...(values["warm-pool"] !== undefined ? { warmPool: Number(values["warm-pool"]) } : {}),
      ...(values.x64 !== undefined ? { x64: values.x64 } : {}),
      ...(values.egress !== undefined ? { egress: values.egress } : {}),
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
  const setting = commandActivity[request.type] === "setting";
  const accepted = setting
    ? await api.settle(
        request,
        values.key ?? randomUUID(),
        AbortSignal.timeout(Number(values.timeout ?? 120000)),
      )
    : await api.submit(request, values.key ?? randomUUID());
  const result = values.wait && !setting ? await waitFor(accepted.id) : accepted;
  output(result);
  if (result.status === "failed" || result.status === "cancelled") process.exitCode = 1;
  if (
    result.status === "action_required" ||
    ((values.wait || setting) &&
      result.status !== "succeeded" &&
      result.status !== "failed" &&
      result.status !== "cancelled")
  )
    process.exitCode = 3;
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
  process.exitCode = issue.code === "wait_cancelled" ? 3 : 1;
});
