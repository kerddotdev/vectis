import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

export const Flavor = Schema.Literals(["development", "production"]);
export type Flavor = typeof Flavor.Type;
export const PackagedBuild = Schema.Struct({
  flavor: Flavor,
  convexUrl: Schema.String,
  webUrl: Schema.String,
});
export type PackagedBuild = typeof PackagedBuild.Type;
const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  vectis: Schema.optional(PackagedBuild),
});

export function findBuildInfo(start: string) {
  for (let directory = start; ; directory = dirname(directory)) {
    let source: string | undefined;
    try {
      source = readFileSync(join(directory, "package.json"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (source !== undefined) {
      const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(source));
      if ((manifest.name === "vectis-workspace" || manifest.name === "vectis") && manifest.version)
        return {
          version: manifest.version,
          flavor: manifest.vectis?.flavor ?? "development",
          root: directory,
          packaged: manifest.vectis,
        };
    }
    if (dirname(directory) === directory)
      throw new Error("The Vectis package manifest was not found.");
  }
}

let cached: ReturnType<typeof findBuildInfo> | undefined;

// Source checkouts and packaged runtimes both keep the root manifest above the compiled module.
// Packagers write the `vectis` field; a manifest without it is a development source checkout.
export function buildInfo() {
  cached ??= findBuildInfo(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
