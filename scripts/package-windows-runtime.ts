import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { inspectLocalArtifact } from "../packages/runner/src/artifact.js";
import { stageRuntimeNotices } from "./release/runtime-notices.js";

const { values } = parseArgs({
  options: {
    qemu: { type: "string" },
    "qemu-img": { type: "string" },
    swtpm: { type: "string" },
    output: { type: "string" },
    "qemu-source": { type: "string" },
  },
});
if (
  !values.qemu ||
  !values["qemu-img"] ||
  !values.swtpm ||
  !values.output ||
  !values["qemu-source"]
)
  throw new Error(
    "Provide --qemu, --qemu-img, --swtpm, --qemu-source and a new --output directory.",
  );
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Windows runtime packaging requires an Apple Silicon Mac.");
const run = promisify(execFile);
await mkdir(dirname(resolve(values.output)), { recursive: true, mode: 0o700 });
await mkdir(resolve(values.output), { mode: 0o700 });
const output = await realpath(values.output);
for (const directory of ["bin", "lib", "libexec", "share/qemu", "licenses/qemu"])
  await mkdir(join(output, directory), { recursive: true });
const entries = [
  ["qemu-system-aarch64", values.qemu],
  ["qemu-img", values["qemu-img"]],
  ["swtpm", values.swtpm],
] as const;
const files = new Map<string, string>();
const names = new Map<string, string>();
const provenance: { source: string; destination: string; sha256: string; bytes: number }[] = [];
const system = (path: string) =>
  path.startsWith("/usr/lib/") || path.startsWith("/System/Library/");
async function dependencies(path: string) {
  const { stdout } = await run("/usr/bin/otool", ["-L", path]);
  return stdout
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const dependency = line.trim().match(/^(.+) \(compatibility version /)?.[1];
      return dependency ? [dependency] : [];
    });
}
async function stage(path: string, destination: string): Promise<void> {
  const source = await realpath(path);
  if (files.has(source)) return;
  const existing = names.get(destination);
  if (existing && existing !== source) throw new Error(`Conflicting library name: ${destination}`);
  const architecture = await run("/usr/bin/lipo", ["-archs", source]);
  if (!architecture.stdout.split(/\s+/).includes("arm64"))
    throw new Error(`Missing ARM64: ${source}`);
  files.set(source, destination);
  names.set(destination, source);
  const artifact = await inspectLocalArtifact(source, AbortSignal.timeout(60000));
  provenance.push({ source, destination, ...artifact });
  const target = join(output, destination);
  await copyFile(source, target);
  await chmod(target, 0o755);
  if (destination.startsWith("lib/"))
    await run("/usr/bin/install_name_tool", [
      "-id",
      `@loader_path/${basename(destination)}`,
      target,
    ]);
  for (const dependency of await dependencies(source)) {
    if (system(dependency)) continue;
    const resolved = dependency.startsWith("@loader_path/")
      ? resolve(dirname(source), dependency.slice("@loader_path/".length))
      : dependency;
    if (!isAbsolute(resolved))
      throw new Error(`Unresolved loader dependency: ${dependency} in ${source}`);
    const canonical = await realpath(resolved);
    if (canonical === source) continue;
    const library = `lib/${basename(canonical)}`;
    await stage(canonical, library);
    const loader = `@loader_path/${relative(dirname(destination), library)}`;
    await run("/usr/bin/install_name_tool", ["-change", dependency, loader, target]);
  }
  const args = ["--force", "--sign", "-"];
  if (destination === "libexec/qemu-system-aarch64")
    args.push("--entitlements", resolve("native/qemu/entitlements.plist"));
  await run("/usr/bin/codesign", [...args, target]);
}
for (const [name, source] of entries) {
  await stage(source, `libexec/${name}`);
  await writeFile(
    join(output, "bin", name),
    `#!/bin/sh
set -eu
VECTIS_RUNTIME_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec "$VECTIS_RUNTIME_ROOT/libexec/${name}"${name === "qemu-system-aarch64" ? ' -L "$VECTIS_RUNTIME_ROOT/share/qemu"' : ""} "$@"
`,
    { mode: 0o755 },
  );
}
for (const destination of files.values()) {
  for (const dependency of await dependencies(join(output, destination))) {
    if (!system(dependency) && !dependency.startsWith("@loader_path/"))
      throw new Error(`External runtime dependency remains: ${dependency}`);
  }
}
for (const name of ["COPYING", "LICENSE"])
  await copyFile(join(values["qemu-source"], name), join(output, "licenses/qemu", name));
await writeFile(
  join(output, "licenses/qemu/0001-align-arm-tpm-ppi-to-host-page.patch"),
  await readFile("native/qemu/patches/0001-align-arm-tpm-ppi-to-host-page.patch"),
);
const versions: Record<string, string> = {};
const notices = await stageRuntimeNotices([...files.keys()], output);
for (const [name] of entries)
  versions[name] = (
    await run(join(output, "bin", name), ["--version"], { env: { PATH: "/usr/bin:/bin" } })
  ).stdout.trim();
await writeFile(
  join(output, "BUILD.json"),
  JSON.stringify(
    {
      scope: "Local development runtime only; not approved for redistribution",
      platform: "darwin-arm64",
      signing: "ad-hoc",
      versions,
      files: provenance,
      notices,
      remainingReleaseRequirements: [
        "Corresponding sources, patches, build recipes and license review for every bundled dependency",
        "Developer ID signing and notarization",
        "Isolated real Windows VM verification",
      ],
      firmware:
        "Not bundled. Supply verified ARM64 firmware explicitly; implicit Homebrew firmware lookup is disabled.",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ output, copiedFiles: files.size, versions, redistributable: false }));
