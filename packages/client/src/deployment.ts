import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { VectisError } from "../../protocol/src/index.js";
import { buildInfo, type Flavor, type PackagedBuild } from "./build.js";

export interface CloudDeployment {
  readonly cloudUrl: string;
  readonly webUrl: string;
}

export function defaultHome(flavor: Flavor = buildInfo().flavor) {
  return join(homedir(), flavor === "production" ? ".vectis" : ".vectis-dev");
}

export function resolveHome(explicit?: string) {
  return explicit ?? process.env.VECTIS_HOME ?? defaultHome();
}

export const environmentFiles = {
  development: ".env.local",
  production: ".env.production.local",
} as const satisfies Record<Flavor, string>;

export function readLocalEnvironment(
  root: string,
  flavor: Flavor = "development",
): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(join(root, environmentFiles[flavor]), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

// Packaged builds only use the deployment baked in at package time, so a VECTIS_CLOUD_URL left in a
// user's shell can never redirect a released app. Source checkouts read the environment first,
// then the repository's .env.local.
export function resolveCloudDeployment(input: {
  packaged: PackagedBuild | undefined;
  environment: Record<string, string | undefined>;
  local: Record<string, string | undefined>;
}): CloudDeployment {
  const cloudUrl =
    input.packaged?.cloudUrl ?? input.environment.VECTIS_CLOUD_URL ?? input.local.VECTIS_CLOUD_URL;
  const webUrl =
    input.packaged?.webUrl ?? input.environment.VECTIS_WEB_URL ?? input.local.VECTIS_WEB_URL;
  if (!cloudUrl || !webUrl)
    throw new VectisError(
      "cloud_unconfigured",
      "This build has no cloud deployment configured.",
      "Set VECTIS_CLOUD_URL and VECTIS_WEB_URL in the environment or the repository .env.local, as described in .env.example.",
    );
  validateCloudUrl(cloudUrl, input.packaged?.flavor ?? "development");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(webUrl))
    throw new VectisError(
      "invalid_web_url",
      "VECTIS_WEB_URL must be an HTTPS origin without a path, such as https://vectis.kerd.dev.",
    );
  return { cloudUrl, webUrl };
}

// Production builds only talk to an HTTPS origin. Development builds may also use a loopback HTTP
// origin served by `wrangler dev`.
export function validateCloudUrl(cloudUrl: string, flavor: Flavor) {
  const https = /^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(cloudUrl);
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(cloudUrl);
  if (!https && !(loopback && flavor === "development"))
    throw new VectisError(
      "invalid_cloud_url",
      "VECTIS_CLOUD_URL must be an HTTPS origin without a path, such as https://cloud.vectis.kerd.dev.",
    );
  return cloudUrl;
}

export function cloudDeployment() {
  const build = buildInfo();
  return resolveCloudDeployment({
    packaged: build.packaged,
    environment: process.env,
    local: build.packaged ? {} : readLocalEnvironment(build.root),
  });
}
