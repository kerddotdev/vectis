import { spawn } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  VectisError,
  type Command,
  type Environment,
} from "../../../packages/protocol/src/index.js";
import { executeGuest, GuestUnavailableError } from "../../../packages/runner/src/guest.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { runnerVersion } from "../../../packages/runner/src/runner-release.js";
import { windowsDefenderCommands } from "../../../packages/runner/src/windows-defender.js";
import { windowsToolchainScript } from "../../../packages/runner/src/windows-toolchain.js";
import { cloneProvisionImage } from "../../../packages/runner/src/provision-image.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { recoverProvisions, startProvision } from "./provision-task.js";

vi.mock("../../../packages/runner/src/guest-ready.js", () => ({ readyGuest: vi.fn() }));
vi.mock("../../../packages/runner/src/guest.js", async (original) => ({
  ...(await original<typeof import("../../../packages/runner/src/guest.js")>()),
  executeGuest: vi.fn(),
}));
vi.mock("../../../packages/runner/src/provision-image.js", () => ({
  cloneProvisionImage: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function fixture(configuration: { exitCode?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "vectis-provision-"));
  const store = new Store(join(home, "state.sqlite"));
  const runtime = new VmRuntime({ home });
  const service = new Service(store, runtime);
  const parent: Environment = {
    id: "parent",
    name: "Parent",
    os: "linux",
    basePath: join(home, "parent.img"),
    state: "ready",
    cpu: 1,
    memoryMiB: 512,
    sshUser: "vectis",
    sshKeyPath: join(home, "parent-key"),
    sshHostKeyMode: "instance",
  };
  await writeFile(parent.basePath, "parent remains immutable");
  store.put("environment", parent.id, parent);
  const command: Extract<Command, { type: "environment.provision" }> = {
    type: "environment.provision",
    id: "derived",
    from: "parent",
    imageDirectory: join(home, "derived"),
  };
  let exit: (() => Promise<void>) | undefined;
  const stop = vi.spyOn(runtime, "stop").mockImplementation(async () => {
    await exit?.();
  });
  const shutdown = vi.spyOn(runtime, "requestShutdown").mockImplementation(async () => {
    await exit?.();
    return true;
  });
  vi.spyOn(runtime, "validate").mockResolvedValue();
  const start = vi
    .spyOn(runtime, "start")
    .mockImplementation(async (id, environment, onExit, signal, options) => {
      signal?.throwIfAborted();
      expect(options).toEqual({ diskInPlace: true });
      await writeFile(environment.basePath, "provisioning writes the clone");
      const helper = join(home, "fake-helper.cjs");
      await writeFile(
        helper,
        `process.stdin.resume(); process.stdin.on('end', () => process.exit(${configuration.exitCode ?? 0}));`,
      );
      const child = spawn(process.execPath, [helper], { stdio: ["pipe", "ignore", "ignore"] });
      const settled = new Promise<void>((resolve) =>
        child.once("close", () => {
          onExit(true);
          resolve();
        }),
      );
      exit = async () => {
        child.stdin.end();
        await settled;
      };
      return {
        id,
        process: child,
        settled,
        directory: runtime.directoryFor(id, environment),
        macAddress: "02:00:00:00:00:01",
      };
    });
  vi.mocked(cloneProvisionImage).mockImplementation(async (environment, id, directory) => {
    const basePath = join(directory, "disk.img");
    await copyFile(environment.basePath, basePath);
    return { ...environment, id, basePath };
  });
  vi.mocked(readyGuest).mockResolvedValue({
    host: "192.0.2.2",
    port: 22,
    user: "vectis",
    identityFile: join(home, "key"),
    knownHostsFile: join(home, "hosts"),
    hostKeyAlias: "test",
  });
  vi.mocked(executeGuest).mockImplementation(async (_connection, script) => {
    if (
      script.includes("poweroff") ||
      script.includes("shutdown.exe") ||
      script.includes("/sbin/shutdown")
    )
      await exit?.();
    return { exitCode: 0, stdout: "", stderr: "", truncated: false };
  });
  cleanups.push(async () => {
    await exit?.();
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  async function submit(input = command) {
    const accepted = service.submit("provision", input);
    await service.drain();
    return accepted;
  }
  async function completed(id: string) {
    await vi.waitFor(() =>
      expect(store.snapshot().operations.find((item) => item.id === id)?.status).not.toMatch(
        /accepted|running/,
      ),
    );
    return store.snapshot().operations.find((item) => item.id === id);
  }
  return {
    home,
    store,
    runtime,
    service,
    parent,
    command,
    submit,
    completed,
    start,
    stop,
    shutdown,
  };
}

test("success freezes and registers a new manifest without changing the parent", async () => {
  const { store, service, parent, command, submit, completed, stop } = await fixture();
  const operation = await submit({
    ...command,
    name: "Repository tools",
    setupScript: "printf 'setup'",
  });
  expect(await completed(operation.id)).toMatchObject({
    status: "succeeded",
    result: {
      stage: "finished",
      environment: {
        id: "derived",
        name: "Repository tools",
        basePath: join(await realpath(command.imageDirectory), "disk.img"),
        image: { parentId: "parent", runnerVersion, revision: operation.id },
      },
    },
  });
  expect(store.snapshot().environments).toHaveLength(2);
  expect(store.snapshot().instances[0]?.status).toBe("stopped");
  expect(store.list("provision")).toHaveLength(0);
  expect(service.snapshot().preparationBusy).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  expect(await readFile(parent.basePath, "utf8")).toBe("parent remains immutable");
  const scripts = vi.mocked(executeGuest).mock.calls.map((call) => call[1]);
  expect(scripts.join("\n")).not.toContain("printf 'setup'");
  expect(scripts.some((script) => script.includes("setup.sh"))).toBe(true);
});

test("a guest script failure stops the owned VM and removes partial output", async () => {
  const { command, store, submit, completed, stop } = await fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "synthetic script failure",
      truncated: false,
    });
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({
    status: "failed",
    result: {
      code: "provision_script_failed",
      exitCode: 1,
      diagnostics: "== stderr\nsynthetic script failure\n== stdout\n",
    },
  });
  expect(stop).toHaveBeenCalledWith(operation.id);
  expect(store.snapshot().environments.map((item) => item.id)).toEqual(["parent"]);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([true, false])(
  "Linux without sudo fails before downloads or setup, runner=%s",
  async (runner) => {
    const { command, store, submit, completed, stop, shutdown } = await fixture();
    vi.mocked(executeGuest).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: a password is required",
      truncated: false,
    });
    const operation = await submit({ ...command, runner, setupScript: "echo must-not-run" });
    expect(await completed(operation.id)).toMatchObject({
      status: "failed",
      result: {
        code: "provision_requires_guest_sudo",
        nextStep:
          "Prepare a new Linux environment with this Vectis version, then provision from it.",
        exitCode: 1,
        diagnostics: expect.stringContaining("a password is required"),
      },
    });
    expect(vi.mocked(executeGuest).mock.calls.map((call) => call[1])).toEqual(["sudo -n true"]);
    expect(shutdown).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(operation.id);
    expect(store.snapshot().environments).toHaveLength(1);
    await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("Linux identity cleanup failure cannot freeze or register an image", async () => {
  const { command, submit, completed, shutdown } = await fixture();
  vi.mocked(executeGuest).mockImplementation(async (_connection, script) => ({
    exitCode: script.includes("clear-identity") ? 23 : 0,
    stdout: "",
    stderr: "synthetic cleanup failure",
    truncated: false,
  }));
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({
    status: "failed",
    result: { code: "provision_identity_reset_failed", exitCode: 23 },
  });
  expect(shutdown).not.toHaveBeenCalled();
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["linux", "macos", "windows"] as const)(
  "%s uses guest shutdown only when the hypervisor request is unavailable",
  async (os) => {
    const { parent, store, submit, completed, shutdown, stop } = await fixture();
    store.put("environment", parent.id, { ...parent, os });
    shutdown.mockResolvedValue(false);
    const operation = await submit();
    expect(await completed(operation.id)).toMatchObject({ status: "succeeded" });
    expect(shutdown).toHaveBeenCalledWith(operation.id);
    const calls = vi.mocked(executeGuest).mock.calls;
    expect(calls.at(-1)?.[1]).toContain("vectis-provision: shutdown");
    expect(stop).not.toHaveBeenCalled();
  },
);

test.each(["linux", "macos", "windows"] as const)(
  "%s shutdown failures retain redacted output and the exit code after cleanup",
  async (os) => {
    const { parent, store, submit, completed, shutdown } = await fixture();
    store.put("environment", parent.id, { ...parent, os });
    shutdown.mockResolvedValue(false);
    vi.mocked(executeGuest).mockImplementation(async (_connection, script) => ({
      exitCode: script.includes("vectis-provision: shutdown") ? 23 : 0,
      stdout: script.includes("vectis-provision: shutdown") ? "vectis-provision: shutdown" : "",
      stderr: script.includes("vectis-provision: shutdown")
        ? "Authorization: Bearer HiddenShutdownCanary\nsudo: a password is required"
        : "",
      truncated: false,
    }));
    const operation = await submit();
    expect(await completed(operation.id)).toMatchObject({
      status: "failed",
      result: {
        code: "guest_shutdown_failed",
        exitCode: 23,
        diagnostics:
          "== stderr\nAuthorization: Bearer [redacted]\nsudo: a password is required\n== stdout\nvectis-provision: shutdown",
      },
    });
    expect(store.snapshot().environments).toHaveLength(1);
  },
);

test("setup upload failure retains bounded diagnostic tails before VM cleanup", async () => {
  const { command, store, submit, completed, stop } = await fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValue({
      exitCode: 28,
      stdout: `discarded-prefix\n${"漢".repeat(10000)}\nupload interrupted`,
      stderr: `Authorization: Bearer ${"a".repeat(10000)}\nNo space left on device`,
      truncated: true,
    });
  const inspectCleanup = stop.getMockImplementation();
  stop.mockImplementation(async (id) => {
    expect(store.snapshot().operations.find((item) => item.id === id)).toMatchObject({
      result: { stage: "cleaning", exitCode: 28, diagnostics: expect.stringContaining("No space") },
    });
    await inspectCleanup?.(id);
  });
  const operation = await submit({ ...command, setupScript: "true" });
  const finished = await completed(operation.id);
  expect(finished).toMatchObject({
    status: "failed",
    result: {
      code: "provision_script_failed",
      exitCode: 28,
      diagnostics: expect.stringContaining("upload interrupted"),
    },
  });
  expect(JSON.stringify(finished?.result)).not.toContain("discarded-prefix");
  expect(JSON.stringify(finished?.result)).not.toContain("a".repeat(100));
  expect(Buffer.byteLength(JSON.stringify(finished?.result))).toBeLessThan(16384);
});

test("unconfirmed cleanup preserves the original guest failure diagnostics", async () => {
  const { store, submit, completed, stop } = await fixture();
  vi.mocked(executeGuest)
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
    .mockResolvedValue({
      exitCode: 7,
      stderr: "download failed",
      stdout: "vectis-provision: download",
      truncated: false,
    });
  stop.mockRejectedValue(new Error("Synthetic cleanup failure"));
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({
    status: "action_required",
    result: {
      code: "provision_cleanup_required",
      exitCode: 7,
      diagnostics: "== stderr\ndownload failed\n== stdout\nvectis-provision: download",
    },
  });
  const instance = store.snapshot().instances.find((item) => item.id === operation.id);
  if (!instance) throw new Error("Missing instance reservation");
  store.put("instance", instance.id, { ...instance, status: "stopped" });
  await recoverProvisions(store);
  expect(await completed(operation.id)).toMatchObject({
    status: "failed",
    result: {
      stage: "cleaned",
      code: "provision_interrupted",
      exitCode: 7,
      diagnostics: "== stderr\ndownload failed\n== stdout\nvectis-provision: download",
    },
  });
});

test("lost provisioning connections retain redacted connection diagnostics", async () => {
  const { submit, completed } = await fixture();
  vi.mocked(executeGuest).mockRejectedValue(
    new GuestUnavailableError("exit 255: token=HiddenConnectionCanary Connection reset"),
  );
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({
    status: "failed",
    result: {
      code: "guest_unavailable",
      diagnostics: "== stderr\nexit 255: token=[redacted] Connection reset\n== stdout\n",
    },
  });
});
test.each(["linux", "macos", "windows"] as const)(
  "%s uses hypervisor shutdown without a privileged guest shutdown command",
  async (os) => {
    const { parent, store, submit, completed, shutdown, stop } = await fixture();
    store.put("environment", parent.id, { ...parent, os });
    const operation = await submit();
    expect(await completed(operation.id)).toMatchObject({
      status: "succeeded",
      result: { environment: { os, image: { runnerVersion } } },
    });
    expect(
      vi
        .mocked(executeGuest)
        .mock.calls.every(
          (call) =>
            call[2].shell ===
            (os === "windows" ? (call[1].startsWith("reg.exe ") ? "cmd" : "powershell") : "bash"),
        ),
    ).toBe(true);
    expect(shutdown).toHaveBeenCalledWith(operation.id);
    expect(stop).not.toHaveBeenCalled();
    const scripts = vi.mocked(executeGuest).mock.calls.map((call) => call[1]);
    expect(scripts.join("\n")).not.toMatch(/poweroff|shutdown/);
    if (os !== "linux") expect(scripts.join("\n")).not.toContain("sudo");
  },
);

test("Windows runs isolated Defender commands in order before toolchain provisioning", async () => {
  const { parent, store, submit, completed } = await fixture();
  store.put("environment", parent.id, { ...parent, os: "windows" });
  const commands = windowsDefenderCommands();
  vi.mocked(executeGuest).mockImplementation(async (_connection, script) => ({
    exitCode: commands.some((command) => command.allowFailure && command.script === script) ? 1 : 0,
    stdout: "",
    stderr: "optional change blocked by Tamper Protection",
    truncated: false,
  }));
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({ status: "succeeded" });
  const calls = vi.mocked(executeGuest).mock.calls;
  expect(
    calls.slice(0, commands.length).map((call) => ({ script: call[1], shell: call[2].shell })),
  ).toEqual(commands.map(({ script, shell }) => ({ script, shell })));
  expect(calls.slice(0, commands.length).every((call) => call[2].shell === "cmd")).toBe(true);
  expect(calls.map((call) => call[1]).join("\n")).not.toMatch(/(?:Add|Set|Get)-Mp/);
  expect(calls[commands.length]?.[1]).toContain(windowsToolchainScript());
  expect(calls[commands.length]?.[1]).not.toMatch(/(?:Add|Set|Get)-Mp/);
});

test.each(["exclusion-policy", "exclusion-path", "transport"])(
  "Windows %s failure prevents toolchain execution",
  async (failure) => {
    const { parent, store, submit, completed, stop } = await fixture();
    store.put("environment", parent.id, { ...parent, os: "windows" });
    const commands = windowsDefenderCommands();
    const failed = commands[failure === "exclusion-policy" ? 0 : 1]?.script;
    vi.mocked(executeGuest).mockImplementation(async (_connection, script) => {
      if (script === failed && failure === "transport")
        throw new GuestUnavailableError("connection lost");
      return {
        exitCode: script === failed ? 1 : 0,
        stdout: "",
        stderr: "actual Defender failure",
        truncated: false,
      };
    });
    const operation = await submit();
    expect(await completed(operation.id)).toMatchObject({
      status: "failed",
      result: {
        code: failure === "transport" ? "guest_unavailable" : "provision_script_failed",
        diagnostics: expect.stringContaining(
          failure === "transport" ? "connection lost" : "actual Defender failure",
        ),
      },
    });
    expect(
      vi.mocked(executeGuest).mock.calls.some((call) => call[1].includes("toolchain-admin-check")),
    ).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  },
);

test("--no-runner does not advertise an inherited runner installation", async () => {
  const { parent, command, store, submit, completed } = await fixture();
  store.put("environment", parent.id, {
    ...parent,
    image: { revision: "old", runnerVersion, provisionedAt: "2026-10-16T00:00:00Z" },
  });
  const operation = await submit({ ...command, runner: false });
  expect(await completed(operation.id)).toMatchObject({ status: "succeeded" });
  expect(
    store.snapshot().environments.find((item) => item.id === command.id)?.image?.runnerVersion,
  ).toBeUndefined();
  expect(
    vi
      .mocked(executeGuest)
      .mock.calls.map((call) => call[1])
      .join("\n"),
  ).not.toMatch(/curl|Invoke-WebRequest/);
});

test("cancellation during cloning deletes partial files without starting a VM", async () => {
  const { command, service, submit, completed, start, stop } = await fixture();
  vi.mocked(cloneProvisionImage).mockImplementation(
    async (_parent, _id, directory, _options, signal) => {
      await writeFile(join(directory, "partial"), "unfinished clone");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    },
  );
  const operation = await submit();
  await vi.waitFor(async () =>
    expect(await readFile(join(command.imageDirectory, "partial"), "utf8")).toBe(
      "unfinished clone",
    ),
  );
  service.submit("cancel-clone", { type: "operation.cancel", id: operation.id });
  await service.drain();
  expect(await completed(operation.id)).toMatchObject({ status: "cancelled" });
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("registration failure rolls back the environment before removing its disk", async () => {
  const { command, store, submit, completed } = await fixture();
  const put = store.put.bind(store);
  vi.spyOn(store, "put").mockImplementation((kind, id, value) => {
    if (
      kind === "operation" &&
      typeof value === "object" &&
      value &&
      "status" in value &&
      value.status === "succeeded" &&
      "command" in value &&
      value.command === "environment.provision"
    )
      throw new Error("Synthetic registration failure");
    put(kind, id, value);
  });
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({ status: "failed" });
  expect(store.snapshot().environments).toHaveLength(1);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("operation cancellation remains available, reserves preparation capacity and removes owned output", async () => {
  const { command, service, store, submit, completed, stop } = await fixture();
  vi.mocked(executeGuest).mockImplementation(
    async (_connection, _script, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      }),
  );
  const operation = await submit();
  await vi.waitFor(() => expect(executeGuest).toHaveBeenCalled());
  expect(service.snapshot().preparationBusy).toBe(true);
  expect(service.snapshot().runnerCapacity?.available).toBe(0);
  const remove = service.submit("remove-active", { type: "environment.remove", id: "parent" });
  service.submit("cancel-provision", { type: "operation.cancel", id: operation.id });
  await service.drain();
  expect(await completed(operation.id)).toMatchObject({ status: "cancelled" });
  expect(stop).toHaveBeenCalledWith(operation.id);
  expect(store.snapshot().operations.find((item) => item.id === remove.id)?.result).toMatchObject({
    code: "preparation_active",
  });
  expect(store.snapshot().environments).toHaveLength(1);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["linux", "macos", "windows"] as const)(
  "%s shutdown timeout forces cleanup and never freezes a dirty image",
  async (os) => {
    const { parent, command, store, runtime, completed, stop, shutdown } = await fixture();
    store.put("environment", parent.id, { ...parent, os });
    shutdown.mockResolvedValue(true);
    vi.mocked(executeGuest)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", truncated: false })
      .mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      });
    const { operation } = store.accept("timeout", "timeout", command.type);
    const active = await startProvision(store, runtime, operation, command, {
      shutdownTimeoutMs: 10,
    });
    await active.done;
    expect(await completed(operation.id)).toMatchObject({
      status: "failed",
      result: { code: "guest_shutdown_timeout" },
    });
    expect(stop).toHaveBeenCalledOnce();
    await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["linux", "macos", "windows"] as const)(
  "%s rejects a failed VM exit after an accepted hypervisor shutdown",
  async (os) => {
    const { parent, command, store, submit, completed, shutdown } = await fixture({ exitCode: 17 });
    store.put("environment", parent.id, { ...parent, os });
    const operation = await submit();
    expect(await completed(operation.id)).toMatchObject({
      status: "failed",
      result: { code: "guest_shutdown_failed" },
    });
    expect(shutdown).toHaveBeenCalledWith(operation.id);
    expect(store.snapshot().environments).toHaveLength(1);
    await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("an accepted shutdown still waits for VM exit and remains cancellable", async () => {
  const { parent, command, store, service, submit, completed, shutdown, stop } = await fixture();
  store.put("environment", parent.id, { ...parent, os: "macos" });
  let requested = () => {};
  const ready = new Promise<void>((resolve) => {
    requested = resolve;
  });
  shutdown.mockImplementation(async () => {
    requested();
    return true;
  });
  const operation = await submit();
  await ready;
  expect(store.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
    status: "running",
    result: { stage: "shutting_down" },
  });
  expect(store.snapshot().environments).toHaveLength(1);
  expect(stop).not.toHaveBeenCalled();
  service.submit("cancel-shutdown", { type: "operation.cancel", id: operation.id });
  await service.drain();
  expect(await completed(operation.id)).toMatchObject({ status: "cancelled" });
  expect(stop).toHaveBeenCalledWith(operation.id);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("stopping the provisioning instance cancels the operation rather than freezing a forced stop", async () => {
  const { command, service, store, submit, completed } = await fixture();
  vi.mocked(executeGuest).mockImplementation(
    async (_connection, _script, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      }),
  );
  const operation = await submit();
  await vi.waitFor(() => expect(executeGuest).toHaveBeenCalled());
  service.submit("stop-instance", { type: "instance.stop", id: operation.id });
  await service.drain();
  expect(await completed(operation.id)).toMatchObject({ status: "cancelled" });
  expect(store.snapshot().environments).toHaveLength(1);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  "id",
  "reserved",
  "not-ready",
  "relative",
  "existing",
  "busy",
  "paused",
  "large-script",
])("rejects %s before cloning and preserves existing files", async (reason) => {
  const { parent, command, store, service, submit, completed, start } = await fixture();
  let input = command;
  if (reason === "id") input = { ...command, id: "parent" };
  if (reason === "reserved")
    store.put("preparation", "reserved", {
      id: "reserved",
      phase: "interrupted",
      configuration: {
        id: "derived",
        name: "Reserved",
        imageDirectory: "/isolated/images",
        storagePath: "/isolated/vms",
        cpu: 1,
        memoryMiB: 512,
        diskGiB: 32,
      },
    });
  if (reason === "not-ready")
    store.put("environment", "parent", { ...parent, state: "action_required" });
  if (reason === "relative") input = { ...command, imageDirectory: "relative/path" };
  if (reason === "existing") {
    await mkdir(command.imageDirectory);
    await writeFile(join(command.imageDirectory, "keep"), "existing data");
  }
  if (reason === "busy")
    store.put("instance", "other", {
      id: "other",
      environmentId: "parent",
      status: "running",
      pid: 0,
      createdAt: new Date().toISOString(),
    });
  if (reason === "paused") {
    service.submit("pause", { type: "machine.pause", paused: true });
    await service.drain();
  }
  if (reason === "large-script") input = { ...command, setupScript: "é".repeat(32769) };
  const operation = await submit(input);
  expect(await completed(operation.id)).toMatchObject({
    status: expect.stringMatching(/failed|action_required/),
  });
  expect(start).not.toHaveBeenCalled();
  expect(cloneProvisionImage).not.toHaveBeenCalled();
  if (reason === "existing")
    expect(await readFile(join(command.imageDirectory, "keep"), "utf8")).toBe("existing data");
});

test("remove refuses parents and preserves their backing file until the child is removed", async () => {
  const { parent, store, service } = await fixture();
  store.put("environment", "child", {
    ...parent,
    id: "child",
    image: { parentId: "parent", revision: "revision", provisionedAt: new Date().toISOString() },
  });
  const refused = service.submit("remove-parent", { type: "environment.remove", id: "parent" });
  await service.drain();
  expect(store.snapshot().operations.find((item) => item.id === refused.id)).toMatchObject({
    status: "failed",
    result: { code: "environment_has_children" },
  });
  service.submit("remove-child", { type: "environment.remove", id: "child" });
  service.submit("remove-parent-again", { type: "environment.remove", id: "parent" });
  await service.drain();
  expect(store.snapshot().environments).toHaveLength(0);
  expect(await readFile(parent.basePath, "utf8")).toBe("parent remains immutable");
});

test("failed startup cleanup preserves output and blocks admission until exit is reconciled", async () => {
  const { command, store, service, submit, completed, start } = await fixture();
  start.mockRejectedValue(new VectisError("vm_start_failed", "Synthetic startup failure"));
  vi.spyOn(service.runtime, "hasWorkDirectory").mockResolvedValue(true);
  const operation = await submit();
  expect(await completed(operation.id)).toMatchObject({
    status: "action_required",
    result: { code: "provision_cleanup_required" },
  });
  expect(service.snapshot().preparationBusy).toBe(true);
  expect((await stat(command.imageDirectory)).isDirectory()).toBe(true);
  await recoverProvisions(store);
  expect(store.list("provision")).toHaveLength(1);
  const instance = store.snapshot().instances[0];
  if (!instance) throw new Error("Missing instance reservation");
  store.put("instance", instance.id, { ...instance, status: "stopped" });
  await recoverProvisions(store);
  await expect(stat(command.imageDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.list("provision")).toHaveLength(0);
});

test.each([false, true])(
  "crash recovery preserves a completed registration=%s and otherwise removes verified owned output",
  async (registered) => {
    const { command, parent, store } = await fixture();
    const { operation } = store.accept("crashed", "crashed", command.type);
    const record = {
      id: operation.id,
      environmentId: command.id,
      directory: command.imageDirectory,
    };
    await mkdir(record.directory);
    await writeFile(join(record.directory, ".vectis-provision.json"), JSON.stringify(record));
    await writeFile(join(record.directory, "disk.img"), "owned output");
    store.put("provision", record.id, record);
    if (registered)
      store.put("environment", command.id, {
        ...parent,
        id: command.id,
        basePath: join(record.directory, "disk.img"),
        image: {
          parentId: parent.id,
          revision: operation.id,
          provisionedAt: new Date().toISOString(),
        },
      });
    await recoverProvisions(store);
    expect(store.list("provision")).toHaveLength(0);
    expect(store.snapshot().operations.find((item) => item.id === operation.id)?.status).toBe(
      registered ? "succeeded" : "failed",
    );
    if (registered)
      expect(await readFile(join(record.directory, "disk.img"), "utf8")).toBe("owned output");
    else await expect(stat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("provisioning refuses to write output inside another registered macOS bundle", async () => {
  const { home, parent, command, store, submit, completed } = await fixture();
  const bundle = join(home, "other.bundle");
  await mkdir(bundle);
  store.put("environment", "other", { ...parent, id: "other", os: "macos", basePath: bundle });
  const operation = await submit({ ...command, imageDirectory: join(bundle, "nested-output") });
  expect(await completed(operation.id)).toMatchObject({
    status: "failed",
    result: { code: "invalid_path" },
  });
  expect(cloneProvisionImage).not.toHaveBeenCalled();
});
