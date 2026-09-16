import { relocatePackageLinks, verifyPackageLinks } from "./release/package-links.js";
import { packager } from "@electron/packager";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    output: { type: "string" },
    sign: { type: "boolean" },
    "keychain-profile": { type: "string" },
  },
});
if (!values.package || !values.output)
  throw new Error(
    "Usage: pnpm package:desktop --package <portable-package> --output <new-directory>",
  );
if (values["keychain-profile"] && !values.sign) throw new Error("Notarization requires --sign.");
const source = await realpath(values.package);
const output = resolve(values.output);
const manifest = Schema.decodeUnknownSync(
  Schema.Struct({ devDependencies: Schema.Struct({ electron: Schema.String }) }),
)(JSON.parse(await readFile("apps/desktop/package.json", "utf8")));
for (const entry of [
  "application/apps/desktop/renderer/index.html",
  "application/dist/apps/desktop/src/main.js",
  "runtime/bin/node",
  "runtime/vectis-vm",
  "runtime/vectis-keychain",
])
  await access(join(source, entry));
await mkdir(output, { mode: 0o700 });
const paths = await packager({
  dir: join(source, "application"),
  out: output,
  name: "Vectis Dev",
  appBundleId: "dev.kerd.vectis.desktop",
  appVersion: "0.1.0",
  buildVersion: "1",
  platform: "darwin",
  arch: "arm64",
  electronVersion: manifest.devDependencies.electron,
  asar: false,
  prune: false,
  derefSymlinks: false,
  afterCopy: [({ buildPath }) => relocatePackageLinks(join(source, "application"), buildPath)],
  overwrite: false,
  extraResource: join(source, "runtime"),
  appCategoryType: "public.app-category.developer-tools",
  extendInfo: { LSMinimumSystemVersion: "15.0" },
  ...(values.sign
    ? {
        osxSign: {
          continueOnError: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: (path: string) => {
            switch (basename(path)) {
              case "vectis-vm":
                return { entitlements: ["com.apple.security.virtualization"] };
              case "qemu-system-aarch64":
                return { entitlements: ["com.apple.security.hypervisor"] };
              case "vectis-keychain":
                return { entitlements: [] };
              case "node":
                return {
                  entitlements: [
                    "com.apple.security.cs.allow-jit",
                    "com.apple.security.cs.allow-unsigned-executable-memory",
                  ],
                };
              default:
                return {};
            }
          },
        },
      }
    : {}),
  ...(values["keychain-profile"]
    ? { osxNotarize: { keychainProfile: values["keychain-profile"] } }
    : {}),
});
for (const path of paths) await verifyPackageLinks(path);
console.log(
  JSON.stringify({
    paths,
    signing: values.sign ? "developer-id" : "development-only",
    notarized: Boolean(values["keychain-profile"]),
  }),
);
