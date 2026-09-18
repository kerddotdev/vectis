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
  version: "26.6.2",
  build: "25G83",
  url: "https://updates.cdn-apple.com/2026SummerFCS/fullrestores/140-75212/A2A24B94-1FC1-45A3-93F7-C51B02AF1F4D/UniversalMac_26.6.2_25G83_Restore.ipsw",
  sha256: "885503b7f4b06609e9a512f2befd40f59730640a3f1233e3892d60affdd51c95",
  bytes: 19772231540,
};

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
