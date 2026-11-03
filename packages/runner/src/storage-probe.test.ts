import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import * as processRunner from "./process.js";
import { probeStorage } from "./storage-probe.js";

test("storage preflight reads an image without changing its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-probe-"));
  try {
    const image = join(root, "image");
    await writeFile(image, "data");
    await probeStorage(image, root).catch((error: unknown) => {
      expect(error).toMatchObject({ code: "storage_headroom" });
    });
    expect(await readdir(root)).toEqual(["image"]);
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

test("storage preflight enforces the working reserve", async () => {
  const run = vi.spyOn(processRunner, "runProcess");
  try {
    run.mockResolvedValueOnce(String(20 * 1024 ** 3 - 1));
    await expect(probeStorage("image", "/volume/vms")).rejects.toMatchObject({
      code: "storage_headroom",
      message: expect.stringContaining("/volume/vms"),
      nextStep: expect.stringContaining("environment configure --storage-path"),
    });
    run.mockResolvedValueOnce(String(20 * 1024 ** 3 + 1));
    await expect(probeStorage("image", "/volume/vms")).resolves.toBeUndefined();
  } finally {
    run.mockRestore();
  }
});
