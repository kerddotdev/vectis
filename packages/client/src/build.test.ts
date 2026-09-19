import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findBuildInfo } from "./build.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("finds the root manifest past versionless workspace manifests", async () => {
  directory = await mkdtemp(join(tmpdir(), "vectis-build-"));
  const module = join(directory, "dist", "packages", "client", "src");
  await mkdir(module, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "vectis", version: "1.2.3" }),
  );
  await writeFile(
    join(directory, "dist", "packages", "client", "package.json"),
    JSON.stringify({ name: "@vectis/client" }),
  );
  expect(findBuildInfo(module)).toMatchObject({
    version: "1.2.3",
    flavor: "development",
    root: directory,
  });
});

test("packaged manifests carry the production flavor and deployment", async () => {
  directory = await mkdtemp(join(tmpdir(), "vectis-build-"));
  const vectis = {
    flavor: "production",
    convexUrl: "https://prod-1.convex.cloud",
    webUrl: "https://vectis.test",
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "vectis", version: "1.2.3", vectis }),
  );
  expect(findBuildInfo(directory)).toMatchObject({ flavor: "production", packaged: vectis });
});

test("fails when no Vectis manifest exists", async () => {
  directory = await mkdtemp(join(tmpdir(), "vectis-build-"));
  expect(() => findBuildInfo(directory ?? "")).toThrow("manifest was not found");
});
