import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { verifyPackageLinks } from "./release/package-links.js";
import { notarizationArguments, notarizeBundle } from "./release/notarization.js";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    launcher: { type: "string" },
    output: { type: "string" },
    identity: { type: "string" },
    notarize: { type: "boolean" },
    "keychain-profile": { type: "string" },
  },
});
if (!values.package || !values.launcher || !values.output)
  throw new Error(
    "Provide --package <portable-payload>, --launcher <native-binary>, and --output <new-directory>.",
  );
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The headless runtime bundle requires Apple Silicon macOS.");
const notarize = values.notarize || Boolean(values["keychain-profile"]);
if (notarize && !values.identity) throw new Error("Notarization requires --identity.");
const authentication = notarize
  ? await notarizationArguments(values["keychain-profile"])
  : undefined;
const source = await realpath(values.package);
await verifyPackageLinks(source);
await mkdir(resolve(values.output), { mode: 0o700 });
const output = await realpath(values.output);
if (output.startsWith(source + sep)) throw new Error("Output must be outside the source payload.");
const app = join(output, "Vectis Runtime.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(resources);
const excluded = [
  join(source, "application/apps/desktop"),
  join(source, "application/dist/apps/desktop"),
];
await cp(join(source, "application"), join(resources, "app"), {
  recursive: true,
  verbatimSymlinks: true,
  filter: (path) => !excluded.some((entry) => path === entry || path.startsWith(entry + sep)),
});
await cp(join(source, "runtime"), join(resources, "runtime"), {
  recursive: true,
  verbatimSymlinks: true,
});
await copyFile(join(source, "BUILD.json"), join(resources, "PAYLOAD.json"));
const launcher = join(contents, "MacOS", "vectis-launcher");
await copyFile(values.launcher, launcher);
await chmod(launcher, 0o755);
await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.kerd.vectis.runtime</string>
<key>CFBundleName</key><string>Vectis Runtime</string>
<key>CFBundleExecutable</key><string>vectis-launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSRemovableVolumesUsageDescription</key><string>Vectis stores and runs virtual machines in the locations you select.</string>
</dict></plist>
`,
);
await verifyPackageLinks(app);
const run = promisify(execFile);
async function sign(path: string) {
  const args = ["--force", "--sign", values.identity ?? "-", "--options", "runtime"];
  if (values.identity) args.push("--timestamp");
  const entitlements =
    basename(path) === "vectis-vm"
      ? "native/apple/entitlements.plist"
      : basename(path) === "qemu-system-aarch64"
        ? "native/qemu/entitlements.plist"
        : basename(path) === "node"
          ? "native/apple/runtime-entitlements.plist"
          : undefined;
  if (entitlements) args.push("--entitlements", resolve(entitlements));
  await run("/usr/bin/codesign", [...args, path]);
}
async function signExecutables(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await signExecutables(path);
    else if (entry.isFile()) {
      const file = await open(path, "r");
      const header = Buffer.alloc(4);
      try {
        await file.read(header, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (
        ["cffaedfe", "cefaedfe", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"].includes(
          header.toString("hex"),
        )
      )
        await sign(path);
    }
  }
}
await signExecutables(resources);
await sign(launcher);
await sign(app);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
await mkdir(join(output, "bin"));
for (const [name, argument] of [
  ["vectis", ""],
  ["vectis-mcp", " --mcp"],
] as const)
  await writeFile(
    join(output, "bin", name),
    `#!/bin/sh
set -eu
VECTIS_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec "$VECTIS_PACKAGE_ROOT/Vectis Runtime.app/Contents/MacOS/vectis-launcher"${argument} "$@"
`,
    { mode: 0o755 },
  );
const notarization = authentication ? await notarizeBundle(app, authentication) : undefined;
await writeFile(
  join(output, "BUILD.json"),
  JSON.stringify(
    {
      platform: "darwin-arm64",
      application: "Vectis Runtime.app",
      electron: false,
      signing: values.identity ? "developer-id" : "ad-hoc-development",
      notarized: Boolean(notarization),
      ...(notarization ? { notarization } : {}),
      payload: "Vectis Runtime.app/Contents/Resources/PAYLOAD.json",
    },
    null,
    2,
  ) + "\n",
);
await run(join(output, "bin/vectis"), ["--help"], { env: { PATH: "/usr/bin:/bin" } });
console.log(JSON.stringify({ output, app, electron: false, notarized: Boolean(notarization) }));
