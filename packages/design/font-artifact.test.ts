import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { archivePin, cachedFonts, downloadFonts } from "./font-artifact.mjs";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vectis-font-test-"));
  roots.push(root);
  const target = join(root, "fonts/general-sans");
  return { root, target };
}
test("a selected ZIP member pointing to a host file never becomes a public font", async () => {
  const { root, target } = await fixture();
  const secret = join(root, "host-only.txt");
  await writeFile(secret, "Synthetic private host content");
  const archive = join(root, "host-link.zip");
  await promisify(execFile)("python3", [
    "-c",
    `import sys,zipfile,stat
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 i=zipfile.ZipInfo('GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Variable.woff2')
 i.create_system=3
 i.external_attr=(stat.S_IFLNK|0o777)<<16
 z.writestr(i,sys.argv[2])`,
    archive,
    secret,
  ]);
  const bytes = await readFile(archive);
  const request = vi.fn(async () => new Response(bytes));
  await expect(downloadFonts(target, request)).rejects.toThrow("pinned size and SHA-256");
  expect(await readFile(secret, "utf8")).toBe("Synthetic private host content");
  await expect(readFile(join(target, "GeneralSans-Variable.woff2"))).rejects.toThrow();
});
test("download redirects, oversized streams and same-sized tampered archives fail closed", async () => {
  const { target } = await fixture();
  const response = new Response("redirect");
  Object.defineProperty(response, "redirected", { value: true });
  await expect(downloadFonts(target, async () => response)).rejects.toThrow("download failed");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(archivePin.bytes + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(downloadFonts(target, async () => new Response(body))).rejects.toThrow(
    "exceeds its pinned size",
  );
  expect(cancelled).toBe(true);
  await expect(
    downloadFonts(target, async () => new Response(new Uint8Array(archivePin.bytes))),
  ).rejects.toThrow("SHA-256");
});
test("existing font and directory links are rejected before reading their targets", async () => {
  const { root, target } = await fixture();
  await mkdir(target, { recursive: true });
  const secret = join(root, "secret");
  await writeFile(secret, "Private fixture");
  await symlink(secret, join(target, "GeneralSans-Variable.woff2"));
  await expect(cachedFonts(target)).rejects.toThrow();
  await rm(target, { recursive: true });
  await symlink(root, target);
  await expect(cachedFonts(target)).rejects.toThrow("directories must not be symbolic links");
});
