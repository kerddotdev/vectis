import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

export async function describeFile(path: string) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { url: basename(path), sha512: hash.digest("base64"), size: (await stat(path)).size };
}

type Described = Awaited<ReturnType<typeof describeFile>>;

// The electron-updater macOS feed: the zip is the update payload, the disk image is listed for
// completeness. Values are quoted so YAML never reinterprets versions or hashes.
export function updateManifest(input: {
  version: string;
  zip: Described;
  diskImage: Described;
  releaseDate: Date;
}) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const file = (entry: Described) =>
    `  - url: ${quote(entry.url)}\n    sha512: ${quote(entry.sha512)}\n    size: ${entry.size}\n`;
  return (
    `version: ${quote(input.version)}\n` +
    `files:\n${file(input.zip)}${file(input.diskImage)}` +
    `path: ${quote(input.zip.url)}\n` +
    `sha512: ${quote(input.zip.sha512)}\n` +
    `releaseDate: ${quote(input.releaseDate.toISOString())}\n`
  );
}
