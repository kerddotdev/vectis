import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { commandLineStatus, installCommandLine } from "./command-line.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("installs shims that run the tools inside the app, even from paths with quotes", async () => {
  directory = await mkdtemp(join(tmpdir(), "vectis-cli-"));
  const resources = join(directory, "It's Vectis.app", "Contents", "Resources");
  const bin = join(directory, "bin");
  await installCommandLine(resources, bin);
  expect(await commandLineStatus(resources, bin, `/usr/bin:${bin}`)).toEqual({
    directory: bin,
    installed: true,
    onPath: true,
  });
  const script = await readFile(join(bin, "vectis"), "utf8");
  const { stdout } = await promisify(execFile)("/bin/sh", [
    "-c",
    script.replace(/^exec /m, "printf %s "),
  ]);
  expect(stdout).toBe(join(resources, "bin", "vectis"));
  expect(await commandLineStatus(join(directory, "Other.app"), bin)).toMatchObject({
    installed: false,
  });
});

test("never replaces a command it did not install", async () => {
  directory = await mkdtemp(join(tmpdir(), "vectis-cli-"));
  await writeFile(join(directory, "vectis"), "#!/bin/sh\necho mine\n");
  await expect(
    installCommandLine("/Applications/Vectis.app/Contents/Resources", directory),
  ).rejects.toThrow("was not installed by Vectis");
  expect(await readFile(join(directory, "vectis"), "utf8")).toBe("#!/bin/sh\necho mine\n");
});
