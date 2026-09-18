import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { verifyRuntimeSources } from "./verify-runtime-sources.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vectis-sources-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const sources = join(root, "sources");
  await mkdir(join(runtime, "licenses/qemu"), { recursive: true });
  await mkdir(sources);
  const content = "verified upstream source";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const artifacts = ["sample", "sample patch 0"].map((name, index) => ({
    name,
    url: `https://example.org/${index}.tar.gz`,
    sha256,
    bytes: Buffer.byteLength(content),
    file: `${index}.tar.gz`,
  }));
  for (const entry of artifacts) await writeFile(join(sources, entry.file), content);
  await writeFile(join(runtime, "COPYING"), "fixture license");
  await writeFile(
    join(runtime, "sbom.spdx.json"),
    JSON.stringify({
      packages: artifacts.map((entry) => ({
        name: entry.name,
        downloadLocation: entry.url,
        checksums: [{ algorithm: "SHA256", checksumValue: entry.sha256 }],
      })),
    }),
  );
  await writeFile(
    join(runtime, "BUILD.json"),
    JSON.stringify({
      notices: [{ name: "sample", version: "1", files: ["COPYING", "./sbom.spdx.json"] }],
    }),
  );
  const component = { name: "sample", version: "1", recipe: "sample.rb", artifacts };
  const manifest = { complete: true, components: [component] };
  await writeFile(join(sources, "SOURCES.json"), JSON.stringify(manifest));
  await writeFile(join(sources, "sample.rb"), "fixture recipe");
  await writeFile(join(sources, "VECTIS-QEMU.md"), "fixture build instructions");
  await writeFile(join(sources, "vectis-qemu.patch"), "fixture patch");
  await writeFile(
    join(runtime, "licenses/qemu/0001-align-arm-tpm-ppi-to-host-page.patch"),
    "fixture patch",
  );
  return { root, runtime, sources, manifest, component };
}
test("verifies bundled version coverage, pinned sources and custom patches", async () => {
  const { runtime, sources } = await fixture();
  await expect(verifyRuntimeSources(runtime, sources)).resolves.toEqual({
    components: 1,
    artifacts: 2,
    customPatchVerified: true,
  });
});
test("rejects damaged sources even when the collection claims completion", async () => {
  const { runtime, sources } = await fixture();
  await writeFile(join(sources, "0.tar.gz"), "tampered");
  await expect(verifyRuntimeSources(runtime, sources)).rejects.toThrow("checksum or size");
});
test("rejects mismatched component versions and omitted upstream patches", async () => {
  const { runtime, sources, manifest, component } = await fixture();
  component.version = "2";
  await writeFile(join(sources, "SOURCES.json"), JSON.stringify(manifest));
  await expect(verifyRuntimeSources(runtime, sources)).rejects.toThrow("runtime versions");
  component.version = "1";
  component.artifacts.pop();
  await writeFile(join(sources, "SOURCES.json"), JSON.stringify(manifest));
  await expect(verifyRuntimeSources(runtime, sources)).rejects.toThrow("patch coverage");
});
test("rejects a source symlink outside the collection", async () => {
  const { root, runtime, sources } = await fixture();
  await writeFile(join(root, "outside"), await readFile(join(sources, "0.tar.gz")));
  await rm(join(sources, "0.tar.gz"));
  await symlink(join(root, "outside"), join(sources, "0.tar.gz"));
  await expect(verifyRuntimeSources(runtime, sources)).rejects.toThrow("escapes its bundle");
});
test("requires the custom source patch to match the patch distributed with the runtime", async () => {
  const { runtime, sources } = await fixture();
  await writeFile(join(sources, "vectis-qemu.patch"), "different patch");
  await expect(verifyRuntimeSources(runtime, sources)).rejects.toThrow("Custom QEMU source patch");
});
