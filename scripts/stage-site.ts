import { cp, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const site = join(web, "site");
const docs = join(site, "docs");
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(join(web, "dist"), site, { recursive: true });
await cp(fileURLToPath(new URL("../../apps/docs/dist/", import.meta.url)), docs, {
  recursive: true,
});
await rename(join(docs, "_headers"), join(site, "_headers"));
await copyFile(join(docs, "llms.txt"), join(site, "llms.txt"));
for (const file of ["404.html", "404.md", "404.json"]) await rm(join(docs, file), { force: true });
