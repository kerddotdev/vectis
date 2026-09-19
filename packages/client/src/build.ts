import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const Manifest = Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String) });

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
        return { version: manifest.version };
    }
    if (dirname(directory) === directory)
      throw new Error("The Vectis package manifest was not found.");
  }
}

let cached: ReturnType<typeof findBuildInfo> | undefined;

// Source checkouts and packaged runtimes both keep the root manifest above the compiled module.
export function buildInfo() {
  cached ??= findBuildInfo(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
