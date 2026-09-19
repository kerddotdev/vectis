import { compileBrandIcons } from "./release/brand-icons.js";
import { relocatePackageLinks, verifyPackageLinks } from "./release/package-links.js";
import { packager } from "@electron/packager";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    output: { type: "string" },
    sign: { type: "boolean" },
    notarize: { type: "boolean" },
    "keychain-profile": { type: "string" },
  },
});
if (!values.package || !values.output)
  throw new Error(
    "Usage: pnpm package:desktop --package <portable-package> --output <new-directory>",
  );
const notarize = values.notarize || Boolean(values["keychain-profile"]);
if (notarize && !values.sign) throw new Error("Notarization requires --sign.");
const notarization = (() => {
  if (!notarize) return undefined;
  if (values["keychain-profile"]) return { keychainProfile: values["keychain-profile"] };
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER)
    throw new Error(
      "Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER for a team API key, or provide --keychain-profile.",
    );
  if (!isAbsolute(APPLE_API_KEY))
    throw new Error("APPLE_API_KEY must be an absolute .p8 file path.");
  return {
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  };
})();
if (notarization && "appleApiKey" in notarization) await access(notarization.appleApiKey);
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
const packaged = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
  JSON.parse(await readFile(join(source, "application", "package.json"), "utf8")),
);
const brandDirectory = join(output, ".brand");
const brand = await compileBrandIcons(brandDirectory);
const paths = await packager({
  icon: brand.icon,
  dir: join(source, "application"),
  out: output,
  name: "Vectis Dev",
  appBundleId: "com.kerddotdev.vectis",
  appVersion: packaged.version,
  buildVersion: "1",
  platform: "darwin",
  arch: "arm64",
  electronVersion: manifest.devDependencies.electron,
  asar: false,
  prune: false,
  derefSymlinks: false,
  afterCopy: [({ buildPath }) => relocatePackageLinks(join(source, "application"), buildPath)],
  overwrite: false,
  extraResource: [join(source, "runtime"), brand.catalog],
  appCategoryType: "public.app-category.developer-tools",
  extendInfo: { LSMinimumSystemVersion: "15.0", CFBundleIconName: "vectis" },
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
  ...(notarization ? { osxNotarize: notarization } : {}),
}).finally(() => rm(brandDirectory, { recursive: true }));
for (const path of paths) await verifyPackageLinks(path);
console.log(
  JSON.stringify({
    paths,
    signing: values.sign ? "developer-id" : "development-only",
    notarized: Boolean(notarization),
  }),
);
