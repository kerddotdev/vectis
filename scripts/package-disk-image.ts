import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, promisify } from "node:util";
import { Schema } from "effect";
import { inspectLocalArtifact } from "../packages/runner/src/artifact.js";
import { notarizationArguments, notarizeBundle } from "./release/notarization.js";
import { verifyPackageLinks } from "./release/package-links.js";

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
  throw Error("Provide --app <notarized-app>, --output <new.dmg>, and --identity <Developer ID>.");
const app = resolve(values.app);
const output = resolve(values.output);
if (!app.endsWith(".app") || !output.endsWith(".dmg"))
  throw Error("Expected an application bundle and a .dmg output.");
await access(output).then(
  () => {
    throw Error("Output already exists.");
  },
  (error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  },
);
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
const staging = await mkdtemp(join(tmpdir(), "vectis-disk-image-"));
try {
  await run("/usr/bin/ditto", [app, join(staging, basename(app))]);
  await symlink("/Applications", join(staging, "Applications"));
  if (values.sources)
    await cp(resolve(values.sources), join(staging, "Corresponding Sources"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  await writeFile(
    join(staging, "Install.txt"),
    "Drag Vectis Dev.app to Applications, then open it and install the background service.\nKeep the app at its installed location while the service uses it.\nFor upgrades, place the new app in a separate permanent folder. Do not overwrite or move the previous app while its service uses it. Open the new app and use its runtime update control when idle; remove the old app only after success.\nThis development artifact does not grant GitHub access automatically.\nDocumentation: https://vectis.kerd.dev/docs/\n",
  );
  await run(
    "/usr/bin/hdiutil",
    ["create", "-srcfolder", staging, "-volname", "Vectis Dev", "-format", "UDZO", output],
    { timeout: 300000 },
  );
  await run("/usr/bin/codesign", ["--sign", values.identity, "--timestamp", output]);
  const notarization = await notarizeBundle(output, authentication, "disk-image");
  const artifact = await inspectLocalArtifact(output, AbortSignal.timeout(60000));
  await writeFile(
    `${output}.json`,
    JSON.stringify(
      { file: basename(output), ...artifact, notarization, developmentOnly: true },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify({ output, ...artifact, notarization }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
