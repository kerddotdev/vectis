import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const security = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
`;
await writeFile(
  join(site, "_headers"),
  security + (await readFile(join(docs, "_headers"), "utf8")),
);
await rm(join(docs, "_headers"));
await copyFile(join(docs, "llms.txt"), join(site, "llms.txt"));
for (const file of ["404.html", "404.md", "404.json"]) await rm(join(docs, file), { force: true });
