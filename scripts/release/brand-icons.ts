import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

export async function compileBrandIcons(output: string) {
  await mkdir(output, { recursive: true });
  await promisify(execFile)("/usr/bin/xcrun", [
    "actool",
    resolve("assets/brand/vectis.icon"),
    "--compile",
    output,
    "--output-format",
    "human-readable-text",
    "--output-partial-info-plist",
    join(output, "brand-info.plist"),
    "--app-icon",
    "vectis",
    "--include-all-app-icons",
    "--enable-on-demand-resources",
    "NO",
    "--development-region",
    "en",
    "--target-device",
    "mac",
    "--minimum-deployment-target",
    "15.0",
    "--platform",
    "macosx",
  ]);
  await access(join(output, "vectis.icns"));
  await access(join(output, "Assets.car"));
  await rm(join(output, "brand-info.plist"));
  return { icon: join(output, "vectis.icns"), catalog: join(output, "Assets.car") };
}
