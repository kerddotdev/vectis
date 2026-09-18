import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Schema } from "effect";
import { inspectLocalArtifact } from "../../packages/runner/src/artifact.js";
import { sourceArtifacts } from "./runtime-sources.js";

const Component = Schema.Struct({ name: Schema.String, version: Schema.String });
const Runtime = Schema.Struct({
  notices: Schema.Array(Schema.Struct({ ...Component.fields, files: Schema.Array(Schema.String) })),
});
const Sources = Schema.Struct({
  complete: Schema.Literal(true),
  components: Schema.Array(
    Schema.Struct({
      ...Component.fields,
      recipe: Schema.String,
      artifacts: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          sha256: Schema.String,
          bytes: Schema.Int,
          file: Schema.String,
        }),
      ),
    }),
  ),
});
async function contained(root: string, file: string) {
  if (isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".."))
    throw Error(`Invalid source material path: ${file}`);
  const path = await realpath(resolve(root, file));
  if (!path.startsWith(root + sep)) throw Error(`Source material escapes its bundle: ${file}`);
  return path;
}
export async function verifyRuntimeSources(runtimeDirectory: string, sourceDirectory: string) {
  const runtimeRoot = await realpath(runtimeDirectory);
  const sourceRoot = await realpath(sourceDirectory);
  const runtime = Schema.decodeUnknownSync(Runtime)(
    JSON.parse(await readFile(join(runtimeRoot, "BUILD.json"), "utf8")),
  );
  const sources = Schema.decodeUnknownSync(Sources)(
    JSON.parse(await readFile(join(sourceRoot, "SOURCES.json"), "utf8")),
  );
  const key = (component: typeof Component.Type) => `${component.name}/${component.version}`;
  const expected = new Set(runtime.notices.map(key));
  const supplied = new Set(sources.components.map(key));
  if (
    expected.size === 0 ||
    expected.size !== runtime.notices.length ||
    supplied.size !== sources.components.length ||
    expected.size !== supplied.size ||
    [...expected].some((name) => !supplied.has(name))
  )
    throw Error("Source components do not match the bundled runtime versions.");
  let artifacts = 0;
  const inspect = async (root: string, file: string) =>
    inspectLocalArtifact(await contained(root, file), AbortSignal.timeout(60000));
  for (const notice of runtime.notices) {
    const component = sources.components.find((entry) => key(entry) === key(notice));
    if (!component) throw Error("Source component missing.");
    const spdxFile = notice.files.find((file) => file.endsWith("/sbom.spdx.json"));
    if (!spdxFile) throw Error(`Bundled source provenance missing: ${notice.name}`);
    for (const file of notice.files) await inspect(runtimeRoot, file);
    const pinned = sourceArtifacts(
      JSON.parse(await readFile(await contained(runtimeRoot, spdxFile), "utf8")),
      notice.name,
    );
    if (
      component.artifacts.length !== pinned.length ||
      new Set(component.artifacts.map((entry) => entry.name)).size !== pinned.length
    )
      throw Error(`Source or patch coverage differs: ${notice.name}`);
    for (const source of pinned) {
      const entry = component.artifacts.find((item) => item.name === source.name);
      if (!entry || entry.url !== source.url || entry.sha256 !== source.sha256)
        throw Error(`Source provenance differs: ${source.name}`);
      const actual = await inspect(sourceRoot, entry.file);
      if (actual.sha256 !== source.sha256 || actual.bytes !== entry.bytes)
        throw Error(`Source checksum or size differs: ${source.name}`);
      artifacts++;
    }
    await inspect(sourceRoot, component.recipe);
  }
  const bundledPatch = await inspect(
    runtimeRoot,
    "licenses/qemu/0001-align-arm-tpm-ppi-to-host-page.patch",
  );
  const sourcePatch = await inspect(sourceRoot, "vectis-qemu.patch");
  if (bundledPatch.sha256 !== sourcePatch.sha256)
    throw Error("Custom QEMU source patch differs from the bundled patch.");
  await inspect(sourceRoot, "VECTIS-QEMU.md");
  return { components: expected.size, artifacts, customPatchVerified: true };
}
