import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalEnvironment } from "../packages/client/src/deployment.js";

const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const site = join(web, "site");
const docs = join(site, "docs");
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(join(web, "dist"), site, { recursive: true });
await cp(fileURLToPath(new URL("../../apps/docs/dist/", import.meta.url)), docs, {
  recursive: true,
});

const flavor = process.env.VECTIS_FLAVOR === "production" ? "production" : "development";
const local = readLocalEnvironment(fileURLToPath(new URL("../../", import.meta.url)), flavor);
const setting = (name: string) => process.env[name] ?? local[name] ?? "";

// The publishable key carries the Clerk frontend host, so the policy always matches the deployment
// the site was built for instead of a second copy of the same value.
function clerkOrigin(publishableKey: string) {
  const decoded = Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ""), "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(decoded) ? `https://${decoded}` : "";
}

async function pages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function route(file: string) {
  const relative = posix.normalize(file.slice(site.length).split("\\").join("/"));
  const path = relative.replace(/\/index\.html$/, "").replace(/\.html$/, "");
  return path === "" ? "/" : path;
}

async function scriptHashes(file: string) {
  const html = await readFile(file, "utf8");
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g))
    if (match[1]?.trim())
      hashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  return [...hashes];
}

const convexUrl = setting("CONVEX_URL");
const clerk = clerkOrigin(setting("CLERK_PUBLISHABLE_KEY"));
const connectSources = [
  "'self'",
  ...(convexUrl ? [convexUrl, convexUrl.replace(/^https:/, "wss:")] : []),
  ...(clerk ? [clerk, "https://*.protect.clerk.com:*"] : []),
];
const common = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
];

function policy(path: string, hashes: string[]) {
  // The account page runs Clerk, which injects its own scripts, styles and bot-protection frames.
  const account = path === "/connect";
  const scripts = account
    ? [
        "'self'",
        "'unsafe-inline'",
        clerk,
        "https://challenges.cloudflare.com",
        clerk && "https://*.protect.clerk.com",
      ]
    : ["'self'", ...hashes];
  return [
    ...common,
    `script-src ${scripts.filter(Boolean).join(" ")}`,
    `connect-src ${account ? connectSources.join(" ") : "'self'"}`,
    ...(account
      ? [
          "worker-src 'self' blob:",
          "frame-src https://challenges.cloudflare.com https://*.protect.clerk.com",
        ]
      : ["frame-src 'none'"]),
  ].join("; ");
}

const security = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
`;
const policies = (
  await Promise.all(
    (await pages(site)).sort().map(async (file) => {
      const path = route(file);
      return `${path}\n  Content-Security-Policy: ${policy(path, await scriptHashes(file))}\n`;
    }),
  )
).join("");
await writeFile(
  join(site, "_headers"),
  security + policies + (await readFile(join(docs, "_headers"), "utf8")),
);
await rm(join(docs, "_headers"));
await copyFile(join(docs, "llms.txt"), join(site, "llms.txt"));
for (const file of ["404.html", "404.md", "404.json"]) await rm(join(docs, file), { force: true });
