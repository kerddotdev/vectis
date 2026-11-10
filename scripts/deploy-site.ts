import { spawn } from "node:child_process";
import { Schema } from "effect";
import { Flavor } from "../packages/client/src/build.js";

const flavor = Schema.decodeUnknownSync(Flavor)(process.argv[2]);
if (process.env.VECTIS_FLAVOR !== flavor)
  throw new Error(`Build the site with VECTIS_FLAVOR=${flavor} before deploying it.`);
await new Promise<void>((done, reject) => {
  const child = spawn(
    "pnpm",
    ["--filter", "@vectis/web", "exec", "wrangler", "deploy", "--env", flavor],
    { stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    code === 0 ? done() : reject(new Error(`wrangler deploy failed (${signal ?? code}).`)),
  );
});
