import { createHash } from "node:crypto";

export function inlineScriptHashes(html: string) {
  const hashes = new Set<string>();
  for (const match of html
    .replace(/\r\n?/g, "\n")
    .matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi))
    if (match[1]?.trim())
      hashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  return [...hashes];
}

export function scriptSources(account: boolean, hashes: string[], clerk: string) {
  // Astro imports the island from a classic inline script. Keep host sources for
  // those imports and Clerk loaders; strict-dynamic blocks this hydration path.
  return account
    ? [
        "'self'",
        ...hashes,
        clerk,
        "https://challenges.cloudflare.com",
        clerk && "https://*.protect.clerk.com",
      ]
    : ["'self'", ...hashes];
}
