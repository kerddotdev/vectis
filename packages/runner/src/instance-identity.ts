import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";

export async function instanceIdentity(directory: string, id: string, signal?: AbortSignal) {
  const media = join(directory, "identity");
  await mkdir(media, { mode: 0o700 });
  const key = join(media, "ssh_host_ed25519_key");
  await runProcess("/usr/bin/ssh-keygen", ["-t", "ed25519", "-N", "", "-C", id, "-f", key], signal);
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  const knownHostsPath = join(directory, "known_hosts");
  await writeFile(knownHostsPath, `${id} ${publicKey}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(media, "instance-id"), `${id}\n`, { flag: "wx", mode: 0o600 });
  const seedPath = join(directory, "identity.iso");
  await runProcess(
    "/usr/bin/hdiutil",
    [
      "makehybrid",
      "-o",
      seedPath,
      media,
      "-iso",
      "-joliet",
      "-default-volume-name",
      "VECTISIDENTITY",
    ],
    signal,
  );
  await rm(media, { recursive: true, force: true });
  return { seedPath, knownHostsPath };
}
