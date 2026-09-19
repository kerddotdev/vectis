import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { Schema } from "effect";
import { Flavor } from "../packages/client/src/build.js";
import { readLocalEnvironment } from "../packages/client/src/deployment.js";

const flavor = Schema.decodeUnknownSync(Flavor)(process.argv[2]);
if (process.env.VECTIS_FLAVOR !== flavor)
  throw new Error(`Build the site with VECTIS_FLAVOR=${flavor} before deploying it.`);
const root = await realpath(process.cwd());
const site = process.env.CONVEX_SITE_URL ?? readLocalEnvironment(root, flavor).CONVEX_SITE_URL;
if (!site || !/^https:\/\/[a-z0-9-]+\.convex\.site$/.test(site))
  throw new Error("Set CONVEX_SITE_URL to the deployment's https://<name>.convex.site URL.");
await new Promise<void>((done, reject) => {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@vectis/web",
      "exec",
      "wrangler",
      "deploy",
      "--env",
      flavor,
      "--var",
      `VECTIS_CONVEX_SITE:${site}`,
    ],
    { stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    code === 0 ? done() : reject(new Error(`wrangler deploy failed (${signal ?? code}).`)),
  );
});
