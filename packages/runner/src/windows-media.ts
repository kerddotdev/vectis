import { randomBytes } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { VectisError, type WindowsInstallation } from "../../protocol/src/index.js";
import { runProcess } from "./process.js";
import { windowsSeed } from "./windows-seed.js";

export interface SetupCredentials {
  get(account: string, signal?: AbortSignal): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
}

export async function prepareWindowsMedia(
  configuration: WindowsInstallation,
  directory: string,
  setupId: string,
  credentials: SetupCredentials,
  signal: AbortSignal,
) {
  if (!configuration.acceptLicense)
    throw new VectisError(
      "license_acceptance_required",
      "Confirm the Windows license terms first.",
    );
  const credentialId = `windows-setup:${setupId}`;
  let password = await credentials.get(credentialId, signal);
  if (!password) {
    password = `V3!${randomBytes(24).toString("base64url")}`;
    await credentials.set(credentialId, password);
  }
  const media = join(directory, "setup-media");
  await mkdir(media, { mode: 0o700, recursive: true });
  for (const name of ["guest-key", "ssh_host_ed25519_key"]) {
    const key = join(directory, name);
    if (!(await stat(key).catch(() => undefined)))
      await runProcess("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], signal);
    await access(key + ".pub", constants.R_OK);
  }
  const key = (await readFile(join(directory, "ssh_host_ed25519_key.pub"), "utf8")).trim();
  await writeFile(join(directory, "known_hosts"), `${configuration.id} ${key}\n`, { mode: 0o600 });
  await copyFile(join(directory, "guest-key.pub"), join(media, "administrators_authorized_keys"));
  for (const name of ["ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"])
    await copyFile(join(directory, name), join(media, name));
  const seed = windowsSeed({
    id: setupId,
    password,
    imageName: configuration.imageName,
    acceptLicense: configuration.acceptLicense,
  });
  await writeFile(join(media, "Autounattend.xml"), seed.answer, { mode: 0o600 });
  await writeFile(join(media, "prepare.ps1"), seed.script, { mode: 0o600 });
  const iso = join(directory, "setup.iso");
  await runProcess(
    "/usr/bin/hdiutil",
    [
      "makehybrid",
      "-iso",
      "-joliet",
      "-default-volume-name",
      "VECTIS_SETUP",
      "-o",
      iso,
      media,
      "-ov",
    ],
    signal,
  );
  await chmod(iso, 0o600);
  return { credentialId, iso };
}
