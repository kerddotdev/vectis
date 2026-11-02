import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { inlineScriptHashes, scriptSources } from "./site-security.js";

test("hashes exact inline bytes, including whitespace, without trusting external or empty scripts", () => {
  const code = "\nwindow.boot = true;\n";
  const html = `<script>${code}</script><script type="module">${code}</script><script src="/external.js">ignored</script><script> </script>`;
  expect(inlineScriptHashes(html)).toEqual([
    `'sha256-${createHash("sha256").update(code).digest("base64")}'`,
  ]);
  expect(inlineScriptHashes(`<script>${code.trim()}</script>`)).not.toEqual(
    inlineScriptHashes(html),
  );
});

test("account bootstrap hashes preserve loader hosts without allowing arbitrary inline scripts", () => {
  const hashes = inlineScriptHashes('<script type="module">import("/island.js")</script>');
  const sources = scriptSources(true, hashes, "https://test.clerk.accounts.dev");
  expect(sources).toEqual(
    expect.arrayContaining([
      ...hashes,
      "https://test.clerk.accounts.dev",
      "https://challenges.cloudflare.com",
    ]),
  );
  expect(sources).not.toContain("'unsafe-inline'");
  expect(sources).not.toContain("'unsafe-eval'");
  expect(sources).not.toContain("'strict-dynamic'");
  expect(scriptSources(false, hashes, "https://test.clerk.accounts.dev")).toEqual([
    "'self'",
    ...hashes,
  ]);
});

test("hashes HTML script casing and parser-normalized line endings", () => {
  expect(inlineScriptHashes("<SCRIPT>window.boot = true;\r\n</SCRIPT>")).toEqual(
    inlineScriptHashes("<script>window.boot = true;\n</script>"),
  );
  expect(inlineScriptHashes('<SCRIPT SRC="/external.js">ignored</SCRIPT>')).toEqual([]);
});
