import { constants } from "node:fs";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { downloadArtifact } from "../packages/runner/src/artifact.js";
import { Flavor } from "../packages/client/src/build.js";
import { readLocalEnvironment, resolveCloudDeployment } from "../packages/client/src/deployment.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    helpers: { type: "string" },
    "windows-runtime": { type: "string" },
    flavor: { type: "string", default: "development" },
  },
});
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The first portable package targets Apple Silicon macOS.");
if (!values.output || !values.helpers)
  throw new Error(
    "Usage: pnpm package:cli --output <new-directory> --helpers <native-bin-directory> [--flavor development|production]",
  );
let output = resolve(values.output);
const helpers = resolve(values.helpers);
const root = await realpath(process.cwd());
const flavor = Schema.decodeUnknownSync(Flavor)(values.flavor);
const cloud = resolveCloudDeployment({
  packaged: undefined,
  environment: process.env,
  local: readLocalEnvironment(root, flavor),
});
const nodeSource = {
  url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
  sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  bytes: 52909993,
};
async function run(executable: string, args: string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? done() : reject(new Error(`${executable} failed (${signal ?? code}).`)),
    );
  });
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
output = await realpath(output);
const application = join(output, "application");
await run("pnpm", [
  "--filter",
  "vectis-workspace",
  "--prod",
  "--ignore-scripts",
  "deploy",
  "--legacy",
  application,
]);
const binaries = join(output, "bin");
const runtime = join(output, "runtime");
await mkdir(binaries);
await mkdir(runtime);
const cache = join(root, ".vectis", "build-cache");
await mkdir(cache, { recursive: true, mode: 0o700 });
const archive = join(cache, "node-v24.21.0-darwin-arm64.tar.gz");
await downloadArtifact(nodeSource, archive, AbortSignal.timeout(300000));
await run("/usr/bin/tar", [
  "-xzf",
  archive,
  "-C",
  runtime,
  "--strip-components=1",
  "node-v24.21.0-darwin-arm64/bin/node",
  "node-v24.21.0-darwin-arm64/LICENSE",
]);
for (const helper of ["vectis-vm", "vectis-keychain"]) {
  const destination = join(runtime, helper);
  await copyFile(join(helpers, helper), destination);
  await chmod(destination, 0o755);
}
if (values["windows-runtime"]) {
  const windows = await realpath(values["windows-runtime"]);
  Schema.decodeUnknownSync(Schema.Struct({ platform: Schema.Literal("darwin-arm64") }))(
    JSON.parse(await readFile(join(windows, "BUILD.json"), "utf8")),
  );
  for (const executable of ["qemu-system-aarch64", "qemu-img", "swtpm"])
    await access(join(windows, "bin", executable), constants.X_OK);
  await cp(windows, join(runtime, "windows"), { recursive: true, verbatimSymlinks: true });
}
await run("/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--entitlements",
  join(root, "native/apple/entitlements.plist"),
  join(runtime, "vectis-vm"),
]);
await run("/usr/bin/codesign", ["--force", "--sign", "-", join(runtime, "vectis-keychain")]);
for (const [name, entry] of [
  ["vectis", "cli"],
  ["vectis-mcp", "mcp"],
] as const) {
  const launcher = join(binaries, name);
  await writeFile(
    launcher,
    `#!/bin/sh
set -eu
VECTIS_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
export VECTIS_APPLE_HELPER="\${VECTIS_APPLE_HELPER:-$VECTIS_PACKAGE_ROOT/runtime/vectis-vm}"
export VECTIS_KEYCHAIN_HELPER="\${VECTIS_KEYCHAIN_HELPER:-$VECTIS_PACKAGE_ROOT/runtime/vectis-keychain}"
if [ -x "$VECTIS_PACKAGE_ROOT/runtime/windows/bin/qemu-system-aarch64" ]; then
  export VECTIS_QEMU="\${VECTIS_QEMU:-$VECTIS_PACKAGE_ROOT/runtime/windows/bin/qemu-system-aarch64}"
  export VECTIS_QEMU_IMG="\${VECTIS_QEMU_IMG:-$VECTIS_PACKAGE_ROOT/runtime/windows/bin/qemu-img}"
  export VECTIS_SWTPM="\${VECTIS_SWTPM:-$VECTIS_PACKAGE_ROOT/runtime/windows/bin/swtpm}"
fi
exec "$VECTIS_PACKAGE_ROOT/runtime/bin/node" "$VECTIS_PACKAGE_ROOT/application/dist/apps/${entry}/src/main.js" "$@"
`,
    { mode: 0o755 },
  );
}
async function inspect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === ".vectis" || entry.name === ".git" || entry.name.startsWith(".env"))
      throw new Error(`Private content in package: ${path}`);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      if (!target.startsWith(output + sep)) throw new Error(`External package symlink: ${path}`);
    } else if (entry.isDirectory()) await inspect(path);
  }
}
await inspect(output);
const manifest = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    dependencies: Schema.Record(Schema.String, Schema.String),
  }),
)(JSON.parse(await readFile(join(application, "package.json"), "utf8")));
await writeFile(
  join(application, "package.json"),
  JSON.stringify(
    {
      name: "vectis",
      license: "MIT",
      version: manifest.version,
      private: true,
      type: "module",
      main: "dist/apps/desktop/src/main.js",
      dependencies: manifest.dependencies,
      vectis: { flavor, ...cloud },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(output, "BUILD.json"),
  JSON.stringify(
    {
      platform: "darwin-arm64",
      flavor,
      signing: "ad-hoc-development",
      node: nodeSource,
      included: ["CLI", "MCP", "local service", "Apple virtualization helper", "Keychain helper"],
      excluded: values["windows-runtime"]
        ? ["OS images", "ARM64 UEFI firmware"]
        : ["QEMU", "qemu-img", "swtpm", "OS images"],
      windowsRuntime: values["windows-runtime"] ? "runtime/windows/BUILD.json" : null,
    },
    null,
    2,
  ) + "\n",
);
await run(join(binaries, "vectis"), ["--help"]);
console.log(
  `Portable development package: ${output}\nKeep this directory intact. Add ${dirname(join(binaries, "vectis"))} to PATH; do not symlink individual launchers.`,
);
