import { constants } from "node:fs";
import { access, mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { VectisError, type MacInstallation } from "../../protocol/src/index.js";
import {
  prepareMacRestore,
  remainingMacRestoreBytes,
  type MacRestoreDownload,
} from "./macos-restore.js";
import { availableHostMemory } from "./memory.js";
import { runPreparationProcess } from "./preparation-process.js";

export async function validateMacInstallation(
  input: MacInstallation,
  helper?: string,
  download?: MacRestoreDownload,
) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new VectisError("unsupported_host", "macOS installation requires an Apple Silicon Mac.");
  if (!helper)
    throw new VectisError("runtime_missing", "Configure the Apple virtualization helper.");
  await access(helper, constants.X_OK);
  if (
    input.cpu < 1 ||
    input.cpu > cpus().length ||
    input.memoryMiB < 4096 ||
    input.memoryMiB * 1024 ** 2 > totalmem() * 0.75 ||
    input.diskGiB < 40 ||
    input.diskGiB > 2048
  )
    throw new VectisError(
      "invalid_resources",
      "Select available CPUs, at least 4096 MiB RAM within the host budget, and a 40-2048 GiB disk.",
    );
  if (
    input.restorePath !== undefined &&
    (!isAbsolute(input.restorePath) ||
      !(await stat(input.restorePath).catch(() => undefined))?.isFile())
  )
    throw new VectisError(
      "restore_image_missing",
      "Select an existing Apple macOS 26 IPSW restore image.",
    );
  for (const directory of [input.imageDirectory, input.storagePath]) {
    if (!isAbsolute(directory) || !(await stat(directory).catch(() => undefined))?.isDirectory())
      throw new VectisError(
        "storage_unavailable",
        "Select existing absolute image and VM storage directories.",
      );
    await access(directory, constants.W_OK | constants.X_OK);
  }
  const space = await statfs(input.imageDirectory);
  const required =
    40 * 1024 ** 3 + (input.restorePath ? 0 : await remainingMacRestoreBytes(download));
  if (space.bavail * space.bsize < required)
    throw new VectisError(
      "insufficient_disk",
      "macOS installation requires 40 GiB free, or 60 GiB when downloading the restore image.",
    );
}
export async function installMacGuest(
  input: MacInstallation,
  helper: string,
  directory: string,
  id: string,
  signal: AbortSignal,
  download?: MacRestoreDownload,
  progress: (phase: "downloading" | "installing", received?: number) => void = () => {},
) {
  await validateMacInstallation(input, helper, download);
  if (input.memoryMiB * 1024 ** 2 > (await availableHostMemory()))
    throw new VectisError("insufficient_memory", "Not enough available memory to install macOS.");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "setup.json"), JSON.stringify({ id, configuration: input }), {
    flag: "wx",
    mode: 0o600,
  });
  const restorePath =
    input.restorePath ??
    (download
      ? await prepareMacRestore(download, signal, (received) => progress("downloading", received))
      : undefined);
  if (!restorePath)
    throw new VectisError("restore_image_missing", "The restore source is unavailable.");
  if (input.memoryMiB * 1024 ** 2 > (await availableHostMemory()))
    throw new VectisError(
      "insufficient_memory",
      "Not enough available memory to install macOS after downloading.",
    );
  progress("installing");
  const bundle = join(directory, "base.bundle");
  await runPreparationProcess(
    {
      helper,
      directory,
      id,
      args: [
        "install-macos",
        restorePath,
        bundle,
        String(input.cpu),
        String(input.memoryMiB),
        String(input.diskGiB),
      ],
      marker: '"installation.action_required"',
      markerStream: "stdout",
    },
    signal,
  );
  return { bundle, build: await installedMacBuild(bundle) };
}
export async function installedMacBuild(bundle: string) {
  const metadata = Schema.decodeUnknownSync(
    Schema.Struct({ build: Schema.NonEmptyString, state: Schema.Literal("action_required") }),
  )(JSON.parse(await readFile(join(bundle, "installation.json"), "utf8")));
  for (const name of [
    "disk.img",
    "hardware-model.bin",
    "machine-identifier.bin",
    "auxiliary-storage.bin",
  ])
    if (!(await stat(join(bundle, name))).isFile())
      throw new VectisError(
        "invalid_macos_bundle",
        "An installed macOS bundle component is missing.",
      );
  return metadata.build;
}
