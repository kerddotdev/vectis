import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSiteArtifact, verifySiteArtifact } from "./site-artifact.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vectis-site-"));
  roots.push(root);
  await mkdir(join(root, "apps/web/site"), { recursive: true });
  await mkdir(join(root, "dist/site-worker"), { recursive: true });
  await writeFile(join(root, "apps/web/site/index.html"), "Verified page");
  await writeFile(join(root, "dist/site-worker/worker.js"), "Verified worker");
  return root;
}
test("deployment verifies both the staged site and the bundled worker against a build-owned digest", async () => {
  const root = await fixture();
  const digest = await createSiteArtifact(root);
  await expect(verifySiteArtifact(root, digest)).resolves.toBeUndefined();
  await writeFile(join(root, "dist/site-worker/worker.js"), "Changed worker");
  await expect(verifySiteArtifact(root, digest)).rejects.toThrow("contents differ");
  await writeFile(join(root, "dist/site-artifact.json"), "Changed manifest");
  await expect(verifySiteArtifact(root, digest)).rejects.toThrow("manifest does not match");
});
test("links and unexpected assets cannot cross into a verified deployment", async () => {
  const root = await fixture();
  const digest = await createSiteArtifact(root);
  await symlink("/etc/hosts", join(root, "apps/web/site/leaked.woff2"));
  await expect(verifySiteArtifact(root, digest)).rejects.toThrow("regular files");
  await rm(join(root, "apps/web/site/leaked.woff2"));
  await writeFile(join(root, "apps/web/site/extra.txt"), "Unbuilt content");
  await expect(verifySiteArtifact(root, digest)).rejects.toThrow("contents differ");
});
