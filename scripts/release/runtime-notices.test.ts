import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stageRuntimeNotices } from "./runtime-notices.js";

test("bundled libraries share their formula's licenses without copying installation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-notices-"));
  try {
    const formula = join(root, "Cellar", "sample", "1.0");
    const output = join(root, "output");
    await mkdir(formula, { recursive: true });
    for (const name of [
      "COPYING",
      "LGPL-2.1-or-later.txt",
      "README.md",
      "sbom.spdx.json",
      "INSTALL_RECEIPT.json",
    ])
      await writeFile(join(formula, name), `original ${name}`);
    const result = await stageRuntimeNotices(
      [
        join(formula, "lib", "one.dylib"),
        join(formula, "lib", "two.dylib"),
        join(root, "custom-qemu"),
      ],
      output,
    );
    expect(result).toHaveLength(1);
    expect(await readdir(join(output, "licenses/homebrew/sample/1.0"))).toEqual([
      "COPYING",
      "LGPL-2.1-or-later.txt",
      "README.md",
      "sbom.spdx.json",
    ]);
    for (const file of result[0]?.files ?? [])
      expect(await readFile(join(output, file), "utf8")).toBe(`original ${file.split("/").at(-1)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a readme alone does not count as installed license materials", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-notices-"));
  try {
    const formula = join(root, "Cellar", "sample", "1.0");
    await mkdir(formula, { recursive: true });
    await writeFile(join(formula, "README.md"), "Build instructions");
    await expect(
      stageRuntimeNotices([join(formula, "lib/sample.dylib")], join(root, "output")),
    ).rejects.toThrow("Installed license materials are missing for sample.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
