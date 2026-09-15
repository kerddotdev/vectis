import { cp, mkdir, rename, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../../apps/docs/", import.meta.url));
const site = join(docs, "site");
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)), site, {
  recursive: true,
});
await cp(join(docs, "dist"), join(site, "docs"), { recursive: true });
await rename(join(site, "docs/llms.txt"), join(site, "llms.txt"));
await rename(join(site, "docs/_headers"), join(site, "_headers"));
await copyFile(join(site, "docs/404.html"), join(site, "404.html"));
await copyFile(join(site, "index.html"), join(site, "connect.html"));
