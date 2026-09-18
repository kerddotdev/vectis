import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { probeStorage } from "./storage-probe.js";

test("storage preflight reads an image without changing its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-probe-"));
  try {
    const image = join(root, "image");
    await writeFile(image, "data");
    await probeStorage(image, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test.skipIf(process.platform === "win32")(
  "cancelling blocked access terminates the isolated probe",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vectis-probe-"));
    try {
      const image = join(root, "pipe");
      execFileSync("mkfifo", [image]);
      const start = Date.now();
      await expect(probeStorage(image, root, AbortSignal.timeout(200))).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("missing storage reports an actionable error", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-probe-"));
  try {
    await expect(probeStorage(join(root, "missing"), root)).rejects.toMatchObject({
      code: "storage_access_required",
      nextStep: expect.stringContaining("Files and Folders"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
