import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import {
  VectisError,
  type Environment,
  type WindowsInstallation,
} from "../../protocol/src/index.js";
import { availableHostMemory } from "./memory.js";
import { inspectLocalArtifact } from "./artifact.js";
import { executeGuest } from "./guest.js";
import { verifyGuestReadiness } from "./guest-ready.js";
import { runProcess } from "./process.js";
import { waitForQemu } from "./qmp.js";
import { windowsVmArguments } from "./windows-arguments.js";
import { prepareWindowsMedia, type SetupCredentials } from "./windows-media.js";
import type { RuntimeOptions } from "./runtime.js";

export async function validateWindowsInstallation(
  input: WindowsInstallation,
  options: RuntimeOptions,
  directory?: string,
) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new VectisError(
      "unsupported_host",
      "Windows installation requires an Apple Silicon Mac.",
    );
  if (!input.acceptLicense)
    throw new VectisError(
      "license_acceptance_required",
      "Confirm the Windows license terms before installing.",
    );
  for (const executable of [options.qemu, options.qemuImg, options.swtpm]) {
    if (!executable)
      throw new VectisError(
        "runtime_missing",
        "Configure QEMU, qemu-img and swtpm before preparing Windows.",
      );
    await access(executable, constants.X_OK);
  }
  if (
    input.cpu < 2 ||
    input.cpu > cpus().length ||
    input.memoryMiB < 4096 ||
    input.memoryMiB * 1024 ** 2 > totalmem() * 0.75 ||
    input.diskGiB < 64 ||
    input.diskGiB > 2048
  )
    throw new VectisError(
      "invalid_resources",
      "Windows needs at least 2 CPUs, 4096 MiB RAM within the host budget and a 64-2048 GiB disk.",
    );
  for (const path of [input.isoPath, input.driversPath, input.firmwarePath, input.firmwareVarsPath])
    if (!isAbsolute(path) || !(await stat(path).catch(() => undefined))?.isFile())
      throw new VectisError(
        "installation_media_missing",
        "Choose existing absolute Windows ARM64, driver ISO and UEFI firmware paths.",
      );
  for (const path of [input.imageDirectory, input.storagePath]) {
    if (!isAbsolute(path) || !(await stat(path).catch(() => undefined))?.isDirectory())
      throw new VectisError(
        "storage_unavailable",
        "Choose existing image and disposable VM directories.",
      );
    await access(path, constants.W_OK | constants.X_OK);
  }
  const free = await statfs(input.imageDirectory);
  const allocated = directory
    ? ((await stat(join(directory, "disk.qcow2")).catch(() => undefined))?.blocks ?? 0) * 512
    : 0;
  if (free.bavail * free.bsize < Math.max(1024 ** 3, 30 * 1024 ** 3 - allocated))
    throw new VectisError(
      "insufficient_disk",
      "Windows installation needs at least 30 GiB of free image storage.",
    );
}

export async function installWindowsGuest(
  input: WindowsInstallation,
  directory: string,
  setupId: string,
  attemptId: string,
  options: RuntimeOptions,
  credentials: SetupCredentials,
  signal: AbortSignal,
  booting: () => void,
): Promise<Environment> {
  await validateWindowsInstallation(input, options, directory);
  if (!options.qemu || !options.qemuImg || !options.swtpm)
    throw new VectisError("runtime_missing", "Windows runtimes are missing.");
  const marker = join(directory, "setup.json");
  const owner = JSON.stringify({ id: setupId, configuration: input });
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(marker, owner, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
      (await readFile(marker, "utf8").catch(() => "")) !== owner
    )
      throw new VectisError(
        "setup_directory_conflict",
        "Cannot verify ownership of the Windows setup directory.",
      );
  }
  const completed = await readFile(join(directory, "image.json"), "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (completed !== undefined) {
    const receipt = Schema.decodeUnknownSync(
      Schema.Struct({
        revision: Schema.Literal("windows-11-arm64-v1"),
        setupId: Schema.String,
        imageName: Schema.String,
      }),
    )(JSON.parse(completed));
    if (receipt.setupId !== setupId || receipt.imageName !== input.imageName)
      throw new VectisError(
        "setup_directory_conflict",
        "The completed image belongs to another setup.",
      );
    for (const file of ["disk.qcow2", "uefi-vars.fd", "guest-key", "known_hosts"])
      if (!(await stat(join(directory, file))).isFile())
        throw new VectisError(
          "invalid_prepared_image",
          "A prepared Windows image component is missing.",
        );
    if (!(await stat(join(directory, "tpm"))).isDirectory())
      throw new VectisError("invalid_prepared_image", "Windows TPM state is missing.");
    return windowsEnvironment(input, directory);
  }
  if (input.memoryMiB * 1024 ** 2 > (await availableHostMemory()))
    throw new VectisError(
      "insufficient_memory",
      "Not enough available host memory to install Windows.",
    );
  const sources = [];
  for (const path of [input.isoPath, input.driversPath, input.firmwarePath, input.firmwareVarsPath])
    sources.push({ path, ...(await inspectLocalArtifact(path, signal)) });
  const sourceRecord = join(directory, "sources.json");
  const previousSources = await readFile(sourceRecord, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (previousSources !== undefined && previousSources !== JSON.stringify(sources))
    throw new VectisError(
      "artifact_changed",
      "Restore the original installation media before resuming this Windows setup.",
    );
  if (previousSources === undefined)
    await writeFile(sourceRecord, JSON.stringify(sources), { flag: "wx", mode: 0o600 });
  const media = await prepareWindowsMedia(input, directory, setupId, credentials, signal);
  const disk = join(directory, "disk.qcow2");
  const fresh = !(await stat(disk).catch(() => undefined));
  if (fresh) {
    await runProcess(options.qemuImg, ["create", "-f", "qcow2", disk, `${input.diskGiB}G`], signal);
  }
  if (!(await stat(join(directory, "uefi-vars.fd")).catch(() => undefined)))
    await copyFile(
      input.firmwareVarsPath,
      join(directory, "uefi-vars.fd"),
      constants.COPYFILE_EXCL,
    );
  await mkdir(join(directory, "tpm"), { mode: 0o700, recursive: true });
  const args = windowsVmArguments(input);
  args[args.indexOf("-serial") + 1] = "file:setup-serial.log";
  args.push("-qmp", "unix:setup-qmp.sock,server=on,wait=off");
  args.push("-device", "qemu-xhci", "-device", "usb-kbd", "-device", "usb-tablet");
  for (const [id, path] of [
    ["install", input.isoPath],
    ["drivers", input.driversPath],
    ["setup", media.iso],
  ]) {
    if (!id || !path) throw new VectisError("installation_media_missing", "Missing setup media.");
    args.push(
      "-drive",
      `file=${path.replaceAll(",", ",,")},if=none,id=${id},format=raw,media=cdrom,readonly=on`,
      "-device",
      `usb-storage,drive=${id}${id === "install" ? ",bootindex=1" : ""}`,
    );
  }
  const supervisor = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./supervisor.ts" : "./supervisor.js",
      import.meta.url,
    ),
  );
  booting();
  const child = spawn(process.execPath, [supervisor, options.qemu, ...args], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VECTIS_VM_TPM_EXECUTABLE: options.swtpm,
      VECTIS_EXIT_RECEIPT: join(directory, "exit-receipt.json"),
      VECTIS_INSTANCE_ID: attemptId,
    },
  });
  child.stdin.on("error", () => {});
  child.on("error", () => {});
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-65536);
  });
  const exited = new AbortController();
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited.abort();
      resolve();
    }),
  );
  const stop = () => child.stdin.end();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const bounded = AbortSignal.any([signal, exited.signal]);
  try {
    const port = await waitForQemu(child);
    child.stdout.resume();
    if (fresh || (await stat(disk)).blocks * 512 < 1024 ** 2) {
      for (let press = 0; press < 20; press++) {
        await delay(1000, undefined, { signal: bounded });
        child.stdin.write(
          JSON.stringify({
            execute: "send-key",
            arguments: { keys: [{ type: "qcode", data: "ret" }] },
          }) + "\n",
        );
      }
    }
    const connection = {
      host: "127.0.0.1",
      port,
      user: "vectis",
      identityFile: join(directory, "guest-key"),
      knownHostsFile: join(directory, "known_hosts"),
      hostKeyAlias: input.id,
    };
    let screenshotAt = 0;
    while (!bounded.aborted) {
      if (Date.now() - screenshotAt > 30000) {
        screenshotAt = Date.now();
        child.stdin.write(
          JSON.stringify({
            execute: "screendump",
            arguments: { filename: join(directory, "setup.ppm") },
          }) + "\n",
        );
      }
      try {
        const result = await executeGuest(
          connection,
          `[Console]::WriteLine([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() + ' ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()); Get-Content C:\\ProgramData\\Vectis\\prepared`,
          { signal: AbortSignal.any([bounded, AbortSignal.timeout(15000)]), shell: "powershell" },
        );
        const lines = result.stdout.trim().split(/\r?\n/);
        if (result.exitCode === 0 && lines.at(-1)?.trim() === setupId) {
          verifyGuestReadiness(lines[0] ?? "");
          const shutdown = await executeGuest(connection, "shutdown.exe /s /t 3", {
            signal: AbortSignal.any([bounded, AbortSignal.timeout(15000)]),
            shell: "powershell",
          });
          if (shutdown.exitCode !== 0)
            throw new VectisError("guest_shutdown_failed", "Windows did not accept shutdown.");
          const waiting = new AbortController();
          try {
            await Promise.race([
              closed,
              delay(60000, undefined, { signal: AbortSignal.any([signal, waiting.signal]) }),
            ]);
          } finally {
            waiting.abort();
          }
          if (!exited.signal.aborted)
            throw new VectisError("guest_shutdown_failed", "Windows did not finish shutting down.");
          await rm(join(directory, "setup-media"), { recursive: true });
          await rm(media.iso);
          await writeFile(
            join(directory, "image.json"),
            JSON.stringify({
              revision: "windows-11-arm64-v1",
              setupId,
              imageName: input.imageName,
              credentialId: media.credentialId,
            }),
            { mode: 0o600 },
          );
          return windowsEnvironment(input, directory);
        }
      } catch (error) {
        if (
          !(error instanceof VectisError) ||
          (error.code !== "guest_unavailable" && error.code !== "guest_cancelled")
        )
          throw error;
        bounded.throwIfAborted();
      }
      await delay(5000, undefined, { signal: bounded });
    }
    throw new VectisError("guest_preparation_failed", "Windows stopped before confirming setup.");
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    const timer = new AbortController();
    try {
      await Promise.race([
        closed,
        delay(10000, undefined, { signal: timer.signal }).then(() => {
          throw new VectisError(
            "reconciliation_required",
            "Windows setup processes have not confirmed exit.",
          );
        }),
      ]);
    } finally {
      timer.abort();
      await writeFile(join(directory, "preparation.log"), diagnostic, { mode: 0o600 });
    }
  }
}

function windowsEnvironment(input: WindowsInstallation, directory: string): Environment {
  return {
    id: input.id,
    name: input.name,
    os: "windows",
    state: "ready",
    cpu: input.cpu,
    memoryMiB: input.memoryMiB,
    basePath: join(directory, "disk.qcow2"),
    storagePath: input.storagePath,
    firmwarePath: input.firmwarePath,
    firmwareVarsPath: join(directory, "uefi-vars.fd"),
    tpmStatePath: join(directory, "tpm"),
    sshUser: "vectis",
    sshKeyPath: join(directory, "guest-key"),
    knownHostsPath: join(directory, "known_hosts"),
  };
}
