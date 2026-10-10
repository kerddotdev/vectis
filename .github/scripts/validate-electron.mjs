import { packager } from "@electron/packager";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (process.platform !== "win32" || process.arch !== "arm64") {
  throw new Error("This validation requires a native Windows ARM64 runner");
}
const root = await mkdtemp(join(tmpdir(), "vectis-electron-validation-"));
const source = join(root, "source");
await mkdir(source);
await writeFile(
  join(source, "package.json"),
  JSON.stringify({
    name: "vectis-environment-validation",
    version: "1.0.0",
    main: "main.cjs",
  }),
);
await writeFile(
  join(source, "main.cjs"),
  "const { app } = require('electron'); app.whenReady().then(() => app.quit());\n",
);
const desktop = JSON.parse(
  await readFile(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"),
);
const paths = await packager({
  dir: source,
  name: "VectisEnvironmentValidation",
  out: join(root, "output"),
  platform: "win32",
  arch: "arm64",
  electronVersion: desktop.devDependencies.electron,
  asar: true,
});
if (paths.length !== 1) throw new Error("Expected one packaged application");
const executable = await readFile(join(paths[0], "VectisEnvironmentValidation.exe"));
const header = executable.readUInt32LE(0x3c);
if (
  executable.toString("ascii", header, header + 4) !== "PE\0\0" ||
  executable.readUInt16LE(header + 4) !== 0xaa64
) {
  throw new Error("The packaged executable is not Windows ARM64");
}
console.log(`Packaged and verified Windows ARM64 Electron application: ${paths[0]}`);
