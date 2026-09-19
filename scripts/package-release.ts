import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, promisify } from "node:util";
import { Schema } from "effect";
import { PackagedBuild } from "../packages/client/src/build.js";
import { desktopIdentity } from "./release/desktop-identity.js";
import { notarizationArguments, notarizeBundle } from "./release/notarization.js";
import { verifyPackageLinks } from "./release/package-links.js";
import { describeFile, updateManifest } from "./release/update-manifest.js";
import { verifyRuntimeSources } from "./release/verify-runtime-sources.js";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    output: { type: "string" },
    identity: { type: "string" },
    sources: { type: "string" },
    "keychain-profile": { type: "string" },
  },
});
if (!values.app || !values.output || !values.identity)
  throw Error(
    "Provide --app <notarized-app>, --output <new-directory>, and --identity <Developer ID>.",
  );
const app = await realpath(values.app);
if (!app.endsWith(".app")) throw Error("Expected an application bundle.");
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const packaged = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.String, vectis: PackagedBuild }),
)(JSON.parse(await readFile(join(app, "Contents/Resources/app/package.json"), "utf8")));
const identity = desktopIdentity(packaged.vectis.flavor);
if (basename(app) !== `${identity.name}.app`)
  throw Error(`Expected ${identity.name}.app for a ${packaged.vectis.flavor} build.`);
const authentication = await notarizationArguments(values["keychain-profile"]);
const run = promisify(execFile);
await verifyPackageLinks(app);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
await run("/usr/bin/xcrun", ["stapler", "validate", app]);
const windows = await access(join(app, "Contents/Resources/runtime/windows/BUILD.json")).then(
  () => true,
  () => false,
);
if (windows && !values.sources) throw Error("Include --sources for the bundled Windows runtime.");
if (values.sources) {
  Schema.decodeUnknownSync(Schema.Struct({ complete: Schema.Literal(true) }))(
    JSON.parse(await readFile(join(values.sources, "SOURCES.json"), "utf8")),
  );
  await verifyPackageLinks(resolve(values.sources));
}
const diskImage = join(output, `${identity.artifact}-arm64.dmg`);
const staging = await mkdtemp(join(tmpdir(), "vectis-disk-image-"));
try {
  await run("/usr/bin/ditto", [app, join(staging, basename(app))]);
  await symlink("/Applications", join(staging, "Applications"));
  if (values.sources)
    await cp(resolve(values.sources), join(staging, "Corresponding Sources"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  if (windows)
    await verifyRuntimeSources(
      join(staging, basename(app), "Contents/Resources/runtime/windows"),
      join(staging, "Corresponding Sources"),
    );
  await run(
    "/usr/bin/hdiutil",
    ["create", "-srcfolder", staging, "-volname", identity.name, "-format", "UDZO", diskImage],
    { timeout: 300000 },
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
await run("/usr/bin/codesign", ["--sign", values.identity, "--timestamp", diskImage]);
const notarization = await notarizeBundle(diskImage, authentication, "disk-image");
const artifacts = [diskImage];
if (identity.updates) {
  const zip = join(output, `${identity.artifact}-${packaged.version}-arm64-mac.zip`);
  await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const feed = join(output, "latest-mac.yml");
  await writeFile(
    feed,
    updateManifest({
      version: packaged.version,
      zip: await describeFile(zip),
      diskImage: await describeFile(diskImage),
      releaseDate: new Date(),
    }),
    { flag: "wx" },
  );
  artifacts.push(zip, feed);
}
console.log(
  JSON.stringify({
    flavor: packaged.vectis.flavor,
    version: packaged.version,
    artifacts,
    notarization,
  }),
);
