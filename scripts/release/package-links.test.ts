import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { relocatePackageLinks, verifyPackageLinks } from "./package-links.js";

test("copied dependencies remain usable after their source package disappears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-package-links-"));
  const source = join(directory, "source");
  const copied = join(directory, "copied");
  try {
    await mkdir(join(source, "store"), { recursive: true });
    await writeFile(join(source, "store/dependency"), "isolated dependency");
    await symlink("store/dependency", join(source, "dependency"));
    await cp(source, copied, { recursive: true });
    await expect(verifyPackageLinks(copied)).rejects.toThrow("External dependency");
    await relocatePackageLinks(source, copied);
    await rename(source, join(directory, "unavailable"));
    await verifyPackageLinks(copied);
    expect(await readFile(join(copied, "dependency"), "utf8")).toBe("isolated dependency");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("unrelated external links are rejected instead of imported into the package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-package-links-"));
  try {
    await mkdir(join(directory, "source"));
    await mkdir(join(directory, "copy"));
    await writeFile(join(directory, "external"), "unrelated");
    await symlink("../external", join(directory, "copy/dependency"));
    await expect(
      relocatePackageLinks(join(directory, "source"), join(directory, "copy")),
    ).rejects.toThrow("External dependency");
  } finally {
    await rm(directory, { recursive: true });
  }
});
