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
  version: "27.0.1",
  build: "26A434",
  url: "https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/UniversalMac_27.0.1_26A434_Restore.ipsw",
  sha256: "2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1",
  bytes: 26637307067,
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
