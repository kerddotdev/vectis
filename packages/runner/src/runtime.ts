import { windowsVmArguments } from "./windows-arguments.js";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { waitForQemu } from "./qmp.js";
import { availableHostMemory } from "./memory.js";
import { runProcess } from "./process.js";
import { waitForAppleVm } from "./apple.js";
import { VectisError, type Environment } from "../../protocol/src/index.js";

export interface RuntimeOptions {
  readonly home: string;
  readonly appleHelper?: string;
  readonly qemu?: string;
  readonly qemuImg?: string;
  readonly swtpm?: string;
}
export interface OwnedInstance {
  readonly id: string;
  readonly process: ChildProcess;
  readonly directory: string;
  readonly settled: Promise<void>;
  readonly macAddress?: string;
  readonly sshHost?: string;
  readonly sshPort?: number;
}
export class VmRuntime {
  private readonly owned = new Map<string, OwnedInstance>();
  constructor(readonly options: RuntimeOptions) {}
  directoryFor(id: string, environment: Environment) {
    return join(environment.storagePath ?? join(this.options.home, "instances"), id);
  }
  validateResources(environment: Environment) {
    if (
      !isAbsolute(environment.basePath) ||
      (environment.storagePath && !isAbsolute(environment.storagePath))
    )
      throw new VectisError("invalid_path", "Image and VM storage paths must be absolute.");
    if (
      !Number.isInteger(environment.cpu) ||
      environment.cpu < 1 ||
      environment.cpu > cpus().length
    )
      throw new VectisError("invalid_resources", "CPU count exceeds this host's capacity.");
    if (!Number.isInteger(environment.memoryMiB) || environment.memoryMiB < 512)
      throw new VectisError("invalid_resources", "Memory must be at least 512 MiB.");
    if (environment.memoryMiB * 1024 ** 2 > totalmem() * 0.75)
      throw new VectisError(
        "invalid_resources",
        "VM memory exceeds the host budget of 75 percent.",
      );
  }
  async validate(environment: Environment) {
    this.validateResources(environment);
    const base = await stat(resolve(environment.basePath)).catch(() => undefined);
    if (!base || (environment.os === "macos" ? !base.isDirectory() : !base.isFile()))
      throw new VectisError(
        "missing_image",
        "The prepared image is missing or has the wrong type.",
        "Provide an existing raw Linux disk, qcow2 Windows disk, or installed macOS bundle.",
      );
    if (environment.storagePath) {
      const storage = await stat(environment.storagePath).catch(() => undefined);
      if (!storage?.isDirectory())
        throw new VectisError(
          "storage_unavailable",
          "The selected VM storage directory is unavailable.",
          "Connect the selected drive and create or select an existing VM directory.",
        );
      await access(environment.storagePath, constants.W_OK | constants.X_OK).catch(() => {
        throw new VectisError(
          "storage_unavailable",
          "The selected VM storage directory is not writable.",
          "Allow Vectis access to the selected directory or choose another location.",
        );
      });
    }
  }
  async start(
    id: string,
    environment: Environment,
    onExit: (cleaned: boolean) => void,
    signal?: AbortSignal,
  ): Promise<OwnedInstance> {
    signal?.throwIfAborted();
    await this.validate(environment);
    signal?.throwIfAborted();
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new VectisError("unsupported_host", "This release requires an Apple Silicon Mac.");
    if (environment.memoryMiB * 1024 * 1024 > (await availableHostMemory()))
      throw new VectisError(
        "insufficient_memory",
        "Not enough free host memory for this instance.",
        "Stop an idle instance or lower the environment memory.",
      );
    if (environment.state !== "ready")
      throw new VectisError(
        "setup_required",
        "The environment still needs setup.",
        "Complete guest setup and mark the prepared environment ready.",
      );
    const executable = environment.os === "windows" ? this.options.qemu : this.options.appleHelper;
    if (!executable)
      throw new VectisError(
        "runtime_missing",
        `The ${environment.os} VM runtime is not configured.`,
        "Configure VECTIS_APPLE_HELPER or VECTIS_QEMU and restart the service.",
      );
    await access(executable, constants.X_OK).catch(() => {
      throw new VectisError("runtime_missing", "The configured VM runtime is not executable.");
    });
    const root = environment.storagePath ?? join(this.options.home, "instances");
    if (!environment.storagePath) await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = this.directoryFor(id, environment);
    await mkdir(directory, { mode: 0o700 });
    try {
      signal?.throwIfAborted();
      let args: string[];
      if (environment.os === "windows") {
        if (
          !environment.firmwarePath ||
          !environment.firmwareVarsPath ||
          !this.options.qemuImg ||
          !this.options.swtpm
        )
          throw new VectisError(
            "setup_required",
            "Windows requires ARM64 UEFI code, a variables template, swtpm, and qemu-img.",
            "Configure the prepared Windows image, firmwarePath, firmwareVarsPath and VECTIS_SWTPM.",
          );
        await access(this.options.swtpm, constants.X_OK);
        await copyFile(
          resolve(environment.firmwareVarsPath),
          join(directory, "uefi-vars.fd"),
          constants.COPYFILE_FICLONE,
        );
        if (environment.tpmStatePath)
          await cp(resolve(environment.tpmStatePath), join(directory, "tpm"), {
            recursive: true,
            mode: constants.COPYFILE_FICLONE,
          });
        else await mkdir(join(directory, "tpm"), { mode: 0o700 });
        const disk = join(directory, "disk.qcow2");
        await runProcess(
          this.options.qemuImg,
          ["create", "-f", "qcow2", "-F", "qcow2", "-b", resolve(environment.basePath), disk],
          signal,
        );
        args = windowsVmArguments({
          firmwarePath: environment.firmwarePath,
          cpu: environment.cpu,
          memoryMiB: environment.memoryMiB,
        });
      } else {
        const destination = join(directory, environment.os === "macos" ? "bundle" : "disk.img");
        await runProcess("/bin/cp", ["-cR", resolve(environment.basePath), destination], signal);
        args = [
          "run",
          environment.os,
          destination,
          String(environment.cpu),
          String(environment.memoryMiB),
          join(directory, "efi.bin"),
          ...(environment.seedPath ? [resolve(environment.seedPath)] : []),
        ];
      }
      await writeFile(
        join(directory, "owner.json"),
        JSON.stringify({ instanceId: id, servicePid: process.pid, environmentId: environment.id }),
        { mode: 0o600 },
      );
      const supervised = environment.os === "windows";
      const supervisor = fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts") ? "./supervisor.ts" : "./supervisor.js",
          import.meta.url,
        ),
      );
      signal?.throwIfAborted();
      const child = spawn(
        supervised ? process.execPath : executable,
        supervised ? [supervisor, executable, ...args] : args,
        {
          stdio: ["pipe", "pipe", supervised ? "pipe" : "ignore"],
          detached: false,
          ...(supervised ? { cwd: directory } : {}),
          env: {
            ...process.env,
            VECTIS_EXIT_RECEIPT: join(directory, "exit-receipt.json"),
            VECTIS_INSTANCE_ID: id,
            ...(supervised && this.options.swtpm
              ? { VECTIS_VM_TPM_EXECUTABLE: this.options.swtpm }
              : {}),
          },
        },
      );
      child.stdin?.on("error", () => {});
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const settled = closed.then(async () => {
        let cleaned = false;
        try {
          await rm(directory, { recursive: true, force: true });
          cleaned = true;
        } finally {
          this.owned.delete(id);
          onExit(cleaned);
        }
      });
      void settled.catch(() => {});
      const instance = { id, process: child, directory, settled };
      this.owned.set(id, instance);
      const cancel = () => {
        void this.stop(id).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let network: { macAddress?: string; sshHost?: string; sshPort?: number } = {};
      try {
        signal?.throwIfAborted();
        if (environment.os === "windows")
          network = { sshHost: "127.0.0.1", sshPort: await waitForQemu(child) };
        else network = await waitForAppleVm(child);
        signal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null)
          throw new VectisError("vm_start_failed", "The VM stopped during startup.");
      } catch (error) {
        if (this.owned.has(id)) await this.stop(id);
        else await settled;
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      child.stdout?.resume();
      child.stderr?.resume();
      const ready = { ...instance, ...network };
      this.owned.set(id, ready);
      return ready;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async hasWorkDirectory(id: string, directory = join(this.options.home, "instances", id)) {
    return stat(directory).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      },
    );
  }
  async reconcile(
    id: string,
    directory = join(this.options.home, "instances", id),
  ): Promise<boolean> {
    if (this.owned.has(id)) return false;
    if (!(await this.hasWorkDirectory(id, directory))) return true;
    try {
      const receipt = Schema.decodeUnknownSync(
        Schema.Struct({ instanceId: Schema.String, pid: Schema.Int }),
      )(JSON.parse(await readFile(join(directory, "exit-receipt.json"), "utf8")));
      if (receipt.instanceId !== id || receipt.pid <= 0) return false;
      try {
        process.kill(receipt.pid, 0);
        return false;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false;
      }
      await rm(directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  async stop(id: string) {
    const instance = this.owned.get(id);
    if (!instance)
      throw new VectisError(
        "not_owned",
        "This service does not own a running instance with that ID.",
        "Inspect interrupted instances; Vectis never kills an unverified PID.",
      );
    if (instance.process.exitCode === null && instance.process.signalCode === null)
      instance.process.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (instance.process.exitCode === null && instance.process.signalCode === null)
        instance.process.kill("SIGKILL");
    }, 5000);
    try {
      await instance.settled;
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    await Promise.all([...this.owned.keys()].map((id) => this.stop(id)));
  }
}
