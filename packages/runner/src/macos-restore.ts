import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
import { downloadArtifact } from "./artifact.js";

export const MacRestoreDownload = Schema.Struct({
  directory: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  artifact: Schema.Struct({ url: Schema.String, sha256: Schema.String, bytes: Schema.Int }),
});
export type MacRestoreDownload = typeof MacRestoreDownload.Type;
export const macosRestore = {
  version: "27.2",
  build: "26B123",
  url: "https://updates.cdn-apple.com/2026FallFCS/c9671975-52db-4fb5-9af2-00217169ba8d/UniversalMac_27.2_26B123_Restore.ipsw",
  sha256: "6613b34e8589db2202a01ec37a2648afb141ece13428175183f8f3e38438534f",
  bytes: 25595669503,
};
// The pinned download is the newest major; earlier majors stay accepted for local restore images and
// setups that started before the pin moved. native/apple MacInstaller.swift mirrors this list.
export const supportedMacGuestMajors = [26, 27] as const;

export async function prepareMacRestore(
  source: MacRestoreDownload,
  signal: AbortSignal,
  progress: (received: number) => void,
  transport: typeof fetch = fetch,
) {
  signal.throwIfAborted();
  const marker = join(source.directory, "restore-source.json");
  const ownership = JSON.stringify(source);
  try {
    await mkdir(source.directory, { mode: 0o700 });
    await writeFile(marker, ownership, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
      (await readFile(marker, "utf8").catch(() => "")) !== ownership
    )
      throw new VectisError(
        "restore_directory_conflict",
        "Restore download ownership could not be verified.",
      );
  }
  const directory = await lstat(source.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new VectisError(
      "restore_directory_conflict",
      "Restore storage must be an owned directory.",
    );
  const path = join(source.directory, "restore.ipsw");
  await downloadArtifact(source.artifact, path, signal, progress, transport);
  return path;
}

export async function remainingMacRestoreBytes(source?: MacRestoreDownload) {
  if (!source) return macosRestore.bytes;
  let present = 0;
  for (const name of ["restore.ipsw", "restore.ipsw.part"]) {
    const file = await lstat(join(source.directory, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file?.isFile() && file.size <= source.artifact.bytes)
      present = Math.max(present, file.size);
  }
  return source.artifact.bytes - present;
}
