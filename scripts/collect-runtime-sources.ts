import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Schema } from "effect";
import { inspectLocalArtifact } from "../packages/runner/src/artifact.js";
import { sourceArtifacts } from "./release/runtime-sources.js";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    output: { type: "string" },
    cellar: { type: "string", default: "/opt/homebrew/Cellar" },
  },
});
if (!values.runtime || !values.output)
  throw Error("Provide --runtime <staged-runtime> and --output <source-directory>.");
const Manifest = Schema.Struct({
  notices: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String })),
});
const manifest = Schema.decodeUnknownSync(Manifest)(
  JSON.parse(await readFile(join(values.runtime, "BUILD.json"), "utf8")),
);
const output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 0o700 });
const run = promisify(execFile);
const collected: {
  name: string;
  version: string;
  recipe: string;
  artifacts: { name: string; url: string; sha256: string; bytes: number; file: string }[];
}[] = [];
for (const formula of manifest.notices) {
  if (
    [".", ".."].includes(formula.name) ||
    [".", ".."].includes(formula.version) ||
    !/^[a-zA-Z0-9@+_.-]+$/.test(formula.name) ||
    !/^[a-zA-Z0-9_.-]+$/.test(formula.version)
  )
    throw Error("Invalid formula path.");
  const root = join(values.cellar, formula.name, formula.version);
  const directory = join(output, formula.name, formula.version);
  await mkdir(directory, { recursive: true });
  const spdx = JSON.parse(await readFile(join(root, "sbom.spdx.json"), "utf8"));
  const sources = sourceArtifacts(spdx, formula.name);
  const recipe = join(formula.name, formula.version, `${formula.name}.rb`);
  await copyFile(join(root, ".brew", `${formula.name}.rb`), join(output, recipe));
  await copyFile(join(root, "sbom.spdx.json"), join(directory, "sbom.spdx.json"));
  const artifacts: (typeof collected)[number]["artifacts"] = [];
  for (const source of sources) {
    const filename = `${source.sha256.slice(0, 16)}-${basename(new URL(source.url).pathname)}`;
    const file = join(formula.name, formula.version, filename);
    const destination = join(output, file);
    let artifact = await inspectLocalArtifact(destination, AbortSignal.timeout(60000)).catch(
      (error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!artifact) {
      const partial = `${destination}.part`;
      await run(
        "/usr/bin/curl",
        [
          "--fail",
          "--location",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--max-time",
          "300",
          "--max-filesize",
          "1073741824",
          "--silent",
          "--show-error",
          "--output",
          partial,
          source.url,
        ],
        { timeout: 310000 },
      );
      artifact = await inspectLocalArtifact(partial, AbortSignal.timeout(60000));
      if (artifact.sha256 !== source.sha256) {
        await rm(partial);
        throw Error(`Source checksum mismatch: ${source.name}`);
      }
      await rename(partial, destination);
    }
    if (artifact.sha256 !== source.sha256) throw Error(`Existing source differs: ${source.name}`);
    artifacts.push({ ...source, bytes: artifact.bytes, file });
  }
  collected.push({ ...formula, recipe, artifacts });
  await writeFile(
    join(output, "SOURCES.json"),
    JSON.stringify({ complete: false, components: collected }, null, 2) + "\n",
  );
  console.log(`Verified sources and recipe: ${formula.name} ${formula.version}`);
}
await copyFile(
  "native/qemu/patches/0001-align-arm-tpm-ppi-to-host-page.patch",
  join(output, "vectis-qemu.patch"),
);
await copyFile("native/qemu/README.md", join(output, "VECTIS-QEMU.md"));
await writeFile(
  join(output, "SOURCES.json"),
  JSON.stringify(
    {
      complete: true,
      redistributionApproved: false,
      scope:
        "Pinned upstream sources, Homebrew patches and installed recipes. Custom build provenance and license review remain required.",
      components: collected,
    },
    null,
    2,
  ) + "\n",
);
