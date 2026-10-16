import { constants } from "node:fs";
import { copyFile, cp, writeFile, mkdir, lstat, realpath, chmod } from "node:fs/promises";
import { join } from "node:path";
import { VectisError, type Environment } from "../../protocol/src/index.js";
import type { RuntimeOptions } from "./runtime.js";
import { runProcess } from "./process.js";

export async function cloneProvisionImage(
  parent: Environment,
  id: string,
  directory: string,
  options: Pick<RuntimeOptions, "qemuImg">,
  signal: AbortSignal,
): Promise<Environment> {
  const basePath = join(
    directory,
    parent.os === "macos" ? "base.bundle" : parent.os === "windows" ? "disk.qcow2" : "disk.img",
  );
  const { image: _image, seedPath: _seed, knownHostsPath: _hosts, ...configuration } = parent;
  const source = await realpath(parent.basePath);
  let environment: Environment = { ...configuration, id, basePath };
  if (parent.os === "windows") {
    if (!options.qemuImg || !parent.firmwareVarsPath)
      throw new VectisError(
        "setup_required",
        "Windows provisioning requires qemu-img and UEFI variables.",
      );
    await runProcess(
      options.qemuImg,
      ["create", "-f", "qcow2", "-F", "qcow2", "-b", source, basePath],
      signal,
    );
    const firmwareVarsPath = join(directory, "uefi-vars.fd");
    await copyFile(parent.firmwareVarsPath, firmwareVarsPath, constants.COPYFILE_FICLONE);
    const tpmStatePath = join(directory, "tpm");
    if (parent.tpmStatePath)
      await cp(await realpath(parent.tpmStatePath), tpmStatePath, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
      });
    else await mkdir(tpmStatePath, { mode: 0o700 });
    environment = { ...environment, firmwareVarsPath, tpmStatePath };
  } else {
    if (parent.os === "macos") {
      for (const file of [
        "disk.img",
        "hardware-model.bin",
        "machine-identifier.bin",
        "auxiliary-storage.bin",
      ])
        if (!(await lstat(join(source, file))).isFile())
          throw new VectisError(
            "invalid_image",
            "macOS image components must be regular files, not symbolic links.",
          );
    }
    await runProcess("/bin/cp", ["-cR", source, basePath], signal);
  }
  signal.throwIfAborted();
  if (!parent.sshUser || !parent.sshKeyPath || (parent.os !== "linux" && !parent.knownHostsPath))
    throw new VectisError(
      "setup_required",
      "The parent environment needs verified guest SSH access.",
    );
  const sshKeyPath = join(directory, "guest-key");
  await copyFile(parent.sshKeyPath, sshKeyPath, constants.COPYFILE_FICLONE);
  await chmod(sshKeyPath, 0o600);
  environment = { ...environment, sshKeyPath };
  if (parent.os !== "linux" && parent.knownHostsPath) {
    const knownHostsPath = join(directory, "known_hosts");
    // ssh-keygen also handles hashed enrollment entries; never trust a fresh network scan.
    const pinned = await runProcess(
      "/usr/bin/ssh-keygen",
      ["-F", parent.id, "-f", parent.knownHostsPath],
      signal,
    );
    const keys = pinned.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    if (!keys.length)
      throw new VectisError("setup_required", "The parent has no pinned SSH host key for its ID.");
    await writeFile(
      knownHostsPath,
      keys.map((line) => line.replace(/^\S+/, id)).join("\n") + "\n",
      { mode: 0o600 },
    );
    environment = { ...environment, knownHostsPath };
  }
  return environment;
}
