import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VectisError } from "../../protocol/src/index.js";
import { guestArguments, sshPathOption, type GuestConnection } from "./guest.js";
import { runProcess } from "./process.js";

export function macEnrollmentArguments(connection: GuestConnection) {
  guestArguments(connection);
  return [
    "-F",
    "/dev/null",
    "-i",
    connection.identityFile + ".pub",
    "-p",
    String(connection.port),
    ...[
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "StrictHostKeyChecking=ask",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "ConnectTimeout=10",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=2",
      "GlobalKnownHostsFile=/dev/null",
      sshPathOption("IdentityFile", connection.identityFile),
      sshPathOption("UserKnownHostsFile", connection.knownHostsFile),
      `HostKeyAlias=${connection.hostKeyAlias}`,
    ].flatMap((value) => ["-o", value]),
    `${connection.user}@${connection.host}`,
  ];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function macEnrollmentScript(connection: GuestConnection) {
  return `#!/bin/sh\nexec /usr/bin/ssh-copy-id ${macEnrollmentArguments(connection).map(quote).join(" ")}\n`;
}
export async function prepareMacAccess(
  directory: string,
  environmentId: string,
  host: string,
  signal: AbortSignal,
) {
  const identityFile = join(directory, "guest-key");
  const key = await lstat(identityFile).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (key && (!key.isFile() || (key.mode & 0o077) !== 0))
    throw new VectisError(
      "invalid_guest_identity",
      "The dedicated guest identity must be a private regular file.",
    );
  if (!key)
    await runProcess(
      "/usr/bin/ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "vectis-guest", "-f", identityFile],
      signal,
    );
  const publicKey = (
    await runProcess("/usr/bin/ssh-keygen", ["-y", "-f", identityFile], signal)
  ).trim();
  const publicPath = identityFile + ".pub";
  const publicFile = await lstat(publicPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!publicFile) await writeFile(publicPath, publicKey + "\n", { flag: "wx", mode: 0o600 });
  else if (
    !publicFile.isFile() ||
    (await readFile(publicPath, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ") !==
      publicKey.split(/\s+/).slice(0, 2).join(" ")
  )
    throw new VectisError(
      "invalid_guest_identity",
      "The public guest key does not match its private identity.",
    );
  const connection = {
    host,
    port: 22,
    user: "vectis",
    identityFile,
    knownHostsFile: join(directory, "known_hosts"),
    hostKeyAlias: environmentId,
  };
  const script = macEnrollmentScript(connection);
  const path = join(directory, "connect-guest.command");
  const temporary = join(directory, `connect-guest-${randomUUID()}.tmp`);
  await writeFile(temporary, script, { flag: "wx", mode: 0o700 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, connection };
}
