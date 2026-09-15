import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, freemem } from "node:os";
import { once } from "node:events";
import { waitForAppleVm } from "./apple.js";
import { VectisError, type Environment } from "../../protocol/src/index.js";

export interface RuntimeOptions {
  readonly home: string;
  readonly appleHelper?: string;
  readonly qemu?: string;
  readonly qemuImg?: string;
}
export interface OwnedInstance {
  readonly id: string;
  readonly process: ChildProcess;
  readonly directory: string;
}
export class VmRuntime {
  private readonly owned = new Map<string, OwnedInstance>();
  constructor(readonly options: RuntimeOptions) {}
  async validate(environment: Environment) {
    if (
      !Number.isInteger(environment.cpu) ||
      environment.cpu < 1 ||
      environment.cpu > cpus().length
    )
      throw new VectisError("invalid_resources", "CPU count exceeds this host's capacity.");
    if (!Number.isInteger(environment.memoryMiB) || environment.memoryMiB < 512)
      throw new VectisError("invalid_resources", "Memory must be at least 512 MiB.");
    const base = await stat(resolve(environment.basePath)).catch(() => undefined);
    if (!base || (environment.os === "macos" ? !base.isDirectory() : !base.isFile()))
      throw new VectisError(
        "missing_image",
        "The prepared image is missing or has the wrong type.",
        "Provide an existing raw Linux disk, qcow2 Windows disk, or installed macOS bundle.",
      );
  }
  async start(id: string, environment: Environment, onExit: () => void): Promise<OwnedInstance> {
    await this.validate(environment);
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new VectisError("unsupported_host", "This release requires an Apple Silicon Mac.");
    if (environment.memoryMiB * 1024 * 1024 > freemem())
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
    const directory = join(this.options.home, "instances", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      let args: string[];
      if (environment.os === "windows") {
        if (!environment.firmwarePath || !environment.tpmSocket || !this.options.qemuImg)
          throw new VectisError(
            "setup_required",
            "Windows requires ARM64 UEFI firmware, a TPM socket, and qemu-img.",
            "Configure a prepared Windows image and its firmware/TPM dependencies.",
          );
        const disk = join(directory, "disk.qcow2");
        await runProcess(this.options.qemuImg, [
          "create",
          "-f",
          "qcow2",
          "-F",
          "qcow2",
          "-b",
          resolve(environment.basePath),
          disk,
        ]);
        args = [
          "-machine",
          "virt,accel=hvf",
          "-cpu",
          "host",
          "-smp",
          String(environment.cpu),
          "-m",
          String(environment.memoryMiB),
          "-bios",
          resolve(environment.firmwarePath),
          "-drive",
          `file=${disk},if=virtio,format=qcow2`,
          "-netdev",
          "user,id=net0",
          "-device",
          "virtio-net-pci,netdev=net0",
          "-chardev",
          `socket,id=chrtpm,path=${environment.tpmSocket}`,
          "-tpmdev",
          "emulator,id=tpm0,chardev=chrtpm",
          "-device",
          "tpm-tis-device,tpmdev=tpm0",
          "-display",
          "none",
          "-monitor",
          "none",
          "-serial",
          "stdio",
        ];
      } else {
        const destination = join(directory, environment.os === "macos" ? "bundle" : "disk.img");
        if (environment.os === "macos")
          await cp(environment.basePath, destination, {
            recursive: true,
            mode: constants.COPYFILE_FICLONE,
          });
        else await copyFile(environment.basePath, destination, constants.COPYFILE_FICLONE);
        args = [
          "run",
          environment.os,
          destination,
          String(environment.cpu),
          String(environment.memoryMiB),
          join(directory, "efi.bin"),
        ];
      }
      await writeFile(
        join(directory, "owner.json"),
        JSON.stringify({ instanceId: id, servicePid: process.pid, environmentId: environment.id }),
        { mode: 0o600 },
      );
      const child = spawn(executable, args, {
        stdio: ["pipe", "pipe", "ignore"],
        detached: false,
      });
      try {
        if (environment.os === "windows") await once(child, "spawn");
        else await waitForAppleVm(child);
      } catch (error) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        throw error;
      }
      child.stdout?.resume();
      const instance = { id, process: child, directory };
      this.owned.set(id, instance);
      child.once("exit", () => {
        this.owned.delete(id);
        onExit();
      });
      return instance;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
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
    const exited = once(instance.process, "exit");
    instance.process.kill("SIGTERM");
    const timer = setTimeout(() => instance.process.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    await rm(instance.directory, { recursive: true, force: true });
  }
  async close() {
    await Promise.all([...this.owned.keys()].map((id) => this.stop(id)));
  }
}
export async function runProcess(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const child = spawn(executable, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output = (output + chunk).slice(-65536);
  });
  child.stderr.resume();
  const [code] = await once(child, "exit");
  if (code !== 0)
    throw new VectisError(
      "process_failed",
      "An external command failed.",
      "Inspect the environment and runtime configuration.",
    );
  return output;
}
