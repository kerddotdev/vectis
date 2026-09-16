import type { RuntimeOptions } from "./runtime.js";
import { Schema } from "effect";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cpus, totalmem } from "node:os";
import {
  VectisError,
  type Environment,
  type LinuxPreparation,
  type Preparation,
} from "../../protocol/src/index.js";
import { downloadArtifact } from "./artifact.js";
import { availableHostMemory } from "./memory.js";
import { runProcess } from "./process.js";
import { preparationStopped, runPreparationGuest } from "./preparation-process.js";
import { linuxSeed, ubuntuImage } from "./linux-seed.js";

export function preparationDirectory(preparation: Preparation) {
  return join(
    preparation.configuration.imageDirectory,
    `vectis-${preparation.configuration.id}-${preparation.id}`,
  );
}
export async function validatePreparation(
  input: LinuxPreparation,
  options: Pick<RuntimeOptions, "appleHelper" | "qemuImg">,
) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new VectisError("unsupported_host", "Guest preparation requires an Apple Silicon Mac.");
  if (!options.appleHelper || !options.qemuImg)
    throw new VectisError(
      "runtime_missing",
      "Configure the Apple virtualization helper and qemu-img before preparing a guest.",
    );
  await access(options.appleHelper, constants.X_OK);
  await access(options.qemuImg, constants.X_OK);
  if (
    !Number.isInteger(input.cpu) ||
    input.cpu < 1 ||
    input.cpu > cpus().length ||
    !Number.isInteger(input.memoryMiB) ||
    input.memoryMiB < 2048 ||
    input.memoryMiB * 1024 ** 2 > totalmem() * 0.75 ||
    !Number.isInteger(input.diskGiB) ||
    input.diskGiB < 16 ||
    input.diskGiB > 2048
  )
    throw new VectisError(
      "invalid_resources",
      "Preparation requires available CPUs, at least 2048 MiB RAM within the host budget, and a 16-2048 GiB disk.",
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
  if (space.bavail * space.bsize < 8 * 1024 ** 3)
    throw new VectisError(
      "insufficient_disk",
      "Guest preparation needs at least 8 GiB of available image storage.",
    );
}
export async function prepareLinux(
  preparation: Preparation,
  options: Pick<RuntimeOptions, "appleHelper" | "qemuImg">,
  signal: AbortSignal,
  progress: (phase: Preparation["phase"], received?: number) => void,
): Promise<Environment> {
  const input = preparation.configuration;
  await validatePreparation(input, options);
  if (!options.appleHelper || !options.qemuImg)
    throw new VectisError("runtime_missing", "The Apple helper and qemu-img are required.");
  const directory = preparationDirectory(preparation);
  const marker = join(directory, "setup.json");
  const owner = JSON.stringify({ id: preparation.id, configuration: input });
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
        "Preparation cannot verify ownership of the selected work directory.",
      );
  }
  if (preparation.phase === "prepared") {
    const image: unknown = JSON.parse(await readFile(join(directory, "image.json"), "utf8"));
    if (
      !Schema.is(
        Schema.Struct({
          revision: Schema.Literal(ubuntuImage.revision),
          sourceSha256: Schema.Literal(ubuntuImage.sha256),
        }),
      )(image)
    )
      throw new VectisError(
        "invalid_prepared_image",
        "Prepared image metadata does not match its source revision.",
      );
    for (const name of ["disk.img", "guest-key", "known_hosts"])
      await access(join(directory, name), constants.R_OK);
    return preparedEnvironment(input, directory);
  }
  if (preparation.phase === "booting" && !(await preparationStopped(directory, preparation.id)))
    throw new VectisError(
      "reconciliation_required",
      "The previous preparation guest has not been confirmed stopped.",
    );
  const archive = join(directory, "ubuntu.qcow2");
  progress("downloading");
  await downloadArtifact(ubuntuImage, archive, signal, (received) =>
    progress("downloading", received),
  );
  progress("converting");
  const raw = join(directory, "source.raw");
  await rm(raw, { force: true });
  await runProcess(options.qemuImg, ["convert", "-f", "qcow2", "-O", "raw", archive, raw], signal);
  const base = join(directory, "disk.img");
  await rm(base, { force: true });
  await copyFile(raw, base, constants.COPYFILE_FICLONE);
  await chmod(base, 0o600);
  const disk = await open(base, "r+");
  try {
    if ((await disk.stat()).size > input.diskGiB * 1024 ** 3)
      throw new VectisError(
        "invalid_disk_size",
        "The target disk is smaller than the source image.",
      );
    await disk.truncate(input.diskGiB * 1024 ** 3);
  } finally {
    await disk.close();
  }
  progress("provisioning");
  async function key(name: string) {
    const path = join(directory, name);
    if (!(await stat(path).catch(() => undefined)))
      await runProcess(
        "/usr/bin/ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", "vectis-guest", "-f", path],
        signal,
      );
    const publicKey = (await runProcess("/usr/bin/ssh-keygen", ["-y", "-f", path], signal)).trim();
    return { path, publicKey };
  }
  const identity = await key("guest-key");
  const host = await key("host-key");
  const seed = linuxSeed({
    id: preparation.id,
    publicKey: identity.publicKey,
    hostPublicKey: host.publicKey,
    hostPrivateKey: await readFile(host.path, "utf8"),
  });
  const seedDirectory = join(directory, "seed");
  await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
  for (const [name, content] of [
    ["meta-data", seed.metadata],
    ["network-config", seed.network],
    ["user-data", seed.userdata],
  ])
    if (name && content) await writeFile(join(seedDirectory, name), content, { mode: 0o600 });
  const knownHostsPath = join(directory, "known_hosts");
  await writeFile(knownHostsPath, `${input.id} ${host.publicKey}\n`, { mode: 0o600 });
  await rm(join(directory, "seed.iso"), { force: true });
  await runProcess(
    "/usr/bin/hdiutil",
    [
      "makehybrid",
      "-o",
      join(directory, "seed.iso"),
      seedDirectory,
      "-iso",
      "-joliet",
      "-default-volume-name",
      "cidata",
    ],
    signal,
  );
  await rm(join(directory, "efi.bin"), { force: true });
  if (input.memoryMiB * 1024 ** 2 > (await availableHostMemory()))
    throw new VectisError("insufficient_memory", "Not enough free memory to prepare this guest.");
  signal.throwIfAborted();
  await rm(join(directory, "exit-receipt.json"), { force: true });
  progress("booting");
  try {
    await runPreparationGuest(
      {
        helper: options.appleHelper,
        directory,
        id: preparation.id,
        cpu: input.cpu,
        memoryMiB: input.memoryMiB,
        marker: seed.marker,
      },
      signal,
    );
  } catch (error) {
    progress("interrupted");
    throw error;
  }
  await writeFile(
    join(directory, "image.json"),
    JSON.stringify({
      revision: ubuntuImage.revision,
      sourceSha256: ubuntuImage.sha256,
      preparedAt: new Date().toISOString(),
      toolchainManifest: "/etc/vectis/toolchain-versions.txt",
    }),
    { mode: 0o600 },
  );
  for (const path of [raw, archive, join(directory, "seed.iso"), host.path, host.path + ".pub"])
    await rm(path, { force: true });
  await rm(seedDirectory, { recursive: true, force: true });
  progress("prepared");
  return preparedEnvironment(input, directory);
}
function preparedEnvironment(input: LinuxPreparation, directory: string): Environment {
  return {
    id: input.id,
    name: input.name,
    os: "linux",
    basePath: join(directory, "disk.img"),
    storagePath: input.storagePath,
    cpu: input.cpu,
    memoryMiB: input.memoryMiB,
    state: "ready",
    sshUser: "vectis",
    sshKeyPath: join(directory, "guest-key"),
    knownHostsPath: join(directory, "known_hosts"),
  };
}
