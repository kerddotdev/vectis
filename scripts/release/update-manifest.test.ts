import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, test } from "vitest";
import { describeFile, updateManifest } from "./update-manifest.js";

test("the update feed points electron-updater at the zip with verifiable hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-feed-"));
  try {
    await writeFile(join(directory, "Vectis-0.1.0-arm64-mac.zip"), "zip");
    await writeFile(join(directory, "Vectis-arm64.dmg"), "dmg");
    const zip = await describeFile(join(directory, "Vectis-0.1.0-arm64-mac.zip"));
    const diskImage = await describeFile(join(directory, "Vectis-arm64.dmg"));
    const feed = parse(
      updateManifest({
        version: "0.1.0",
        zip,
        diskImage,
        releaseDate: new Date("2026-09-19T00:00:00Z"),
      }),
    );
    expect(feed).toEqual({
      version: "0.1.0",
      files: [
        { url: "Vectis-0.1.0-arm64-mac.zip", sha512: zip.sha512, size: 3 },
        { url: "Vectis-arm64.dmg", sha512: diskImage.sha512, size: 3 },
      ],
      path: "Vectis-0.1.0-arm64-mac.zip",
      sha512: zip.sha512,
      releaseDate: "2026-09-19T00:00:00.000Z",
    });
    expect(zip.sha512).toBe(
      "A5JY2soDJJhmgGhmPv6GEdDq+HBY/XClPIYl3ihyBDSzsovWx0Zygh1Ia3qqCnnyhsAwSsPI8qr1BFKbpXR0tA==",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
