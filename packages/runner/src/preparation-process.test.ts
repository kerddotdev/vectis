import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { preparationStopped, runPreparationGuest } from "./preparation-process.js";
async function fixture(body: string, run: (helper: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vectis-prepare-process-"));
  const helper = join(directory, "helper");
  await writeFile(helper, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  try {
    await run(helper, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("successful preparation requires a marker and observed process exit", () =>
  fixture('process.stderr.write("VECTIS_READY\\n");', async (helper, directory) => {
    await runPreparationGuest(
      { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
      new AbortController().signal,
    );
    expect(await preparationStopped(directory, "setup")).toBe(true);
    expect(await preparationStopped(directory, "other")).toBe(false);
  }));
test("cancellation closes the owned guest and retains a verifiable exit receipt", () =>
  fixture(
    'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));',
    async (helper, directory) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 50);
      try {
        await expect(
          runPreparationGuest(
            { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
            abort.signal,
          ),
        ).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
      expect(await preparationStopped(directory, "setup")).toBe(true);
      expect((await stat(join(directory, "preparation.log"))).mode & 0o777).toBe(0o600);
    },
  ));
test("a clean process exit without completed guest setup is not success", () =>
  fixture("process.exit(0);", async (helper, directory) => {
    await expect(
      runPreparationGuest(
        { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "guest_preparation_failed" });
  }));
