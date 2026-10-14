import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const roots = ["apps/web/site", "dist/site-worker"];
const manifestPath = "dist/site-artifact.json";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function inventory(root: string) {
  const entries: { path: string; sha256: string; bytes: number }[] = [];
  async function visit(directory: string) {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Site artifact directories must not be links.");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else {
        if (!stat.isFile()) throw new Error("Site artifacts must contain only regular files.");
        const bytes = await readFile(path);
        entries.push({
          path: relative(root, path).split("\\").join("/"),
          sha256: digest(bytes),
          bytes: bytes.length,
        });
      }
    }
  }
  for (const path of roots) await visit(join(root, path));
  return entries;
}
export async function createSiteArtifact(root: string) {
  const manifest = JSON.stringify(await inventory(root));
  await writeFile(join(root, manifestPath), manifest, { flag: "wx" });
  return digest(Buffer.from(manifest));
}
export async function verifySiteArtifact(root: string, expectedDigest: string) {
  const path = join(root, manifestPath);
  if (!(await lstat(path)).isFile()) throw new Error("Site manifest must be a regular file.");
  const manifest = await readFile(path);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(manifest) !== expectedDigest)
    throw new Error("Site artifact manifest does not match the build job's digest.");
  if (manifest.toString() !== JSON.stringify(await inventory(root)))
    throw new Error("Site artifact contents differ from the verified build.");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "create")
    console.log(`digest=${await createSiteArtifact(process.cwd())}`);
  else if (process.argv[2] === "verify")
    await verifySiteArtifact(process.cwd(), process.env.VECTIS_SITE_ARTIFACT_DIGEST ?? "");
  else throw new Error("Use create or verify.");
}
