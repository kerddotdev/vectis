import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const launcherVersion = 1;
const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(desktopDirectory, "../..");

async function brandIcons(output) {
  const { compileBrandIcons } = await import("../../scripts/release/brand-icons.ts");
  const previous = process.cwd();
  process.chdir(repository);
  try {
    return await compileBrandIcons(output);
  } finally {
    process.chdir(previous);
  }
}

async function developmentBundle() {
  const source = resolve(dirname(electron), "../..");
  const runtime = join(desktopDirectory, ".electron-runtime");
  const bundle = join(runtime, "Vectis Dev.app");
  const executable = join(bundle, "Contents", "MacOS", "Electron");
  const iconSource = join(repository, "assets", "brand", "vectis.icon");
  const metadataPath = join(runtime, "metadata.json");
  const metadata = JSON.stringify({
    launcherVersion,
    source,
    icon: Math.max(
      ...readdirSync(iconSource, { recursive: true }).map(
        (entry) => statSync(join(iconSource, entry)).mtimeMs,
      ),
    ),
  });
  if (
    existsSync(executable) &&
    existsSync(metadataPath) &&
    readFileSync(metadataPath, "utf8") === metadata
  )
    return executable;

  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
  const plist = join(bundle, "Contents", "Info.plist");
  let iconReady = false;
  const info = {
    CFBundleName: "Vectis Dev",
    CFBundleDisplayName: "Vectis Dev",
    CFBundleIdentifier: "com.kerddotdev.vectis.dev.local",
  };
  try {
    const icons = await brandIcons(join(runtime, "brand"));
    const resources = join(bundle, "Contents", "Resources");
    cpSync(icons.icon, join(resources, "vectis.icns"));
    cpSync(icons.catalog, join(resources, "Assets.car"));
    Object.assign(info, { CFBundleIconFile: "vectis.icns", CFBundleIconName: "vectis" });
    iconReady = true;
  } catch (error) {
    console.warn(
      `Vectis dev icon unavailable, using the Electron icon: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
    );
  }
  for (const [key, value] of Object.entries(info))
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    bundle,
  ]);
  if (iconReady) writeFileSync(metadataPath, metadata);
  return executable;
}

const executable = process.platform === "darwin" ? await developmentBundle() : electron;
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
const child = spawn(executable, [desktopDirectory, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...environment, VECTIS_NODE_EXECUTABLE: process.execPath },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
