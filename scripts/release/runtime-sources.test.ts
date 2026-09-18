import { expect, test } from "vitest";
import { sourceArtifacts } from "./runtime-sources.js";
const sha256 = "a".repeat(64);
const source = (name: string, url: string) => ({
  name,
  downloadLocation: url,
  checksums: [{ algorithm: "SHA256", checksumValue: sha256 }],
});
test("selects exact upstream sources and patches rather than binary bottles", () => {
  expect(
    sourceArtifacts(
      {
        packages: [
          source("sample", "https://example.org/source.tar.gz"),
          source("sample", "https://ghcr.io/bottle"),
          source("sample patch 0", "https://example.org/fix.patch"),
          source("other", "https://example.org/other.tar.gz"),
        ],
      },
      "sample",
    ).map((item) => item.name),
  ).toEqual(["sample", "sample patch 0"]);
});
test("requires a pinned HTTPS upstream source", () => {
  expect(() =>
    sourceArtifacts({ packages: [source("sample", "https://ghcr.io/bottle")] }, "sample"),
  ).toThrow("Missing upstream");
  expect(() =>
    sourceArtifacts({ packages: [source("sample", "http://example.org/source")] }, "sample"),
  ).toThrow("Missing pinned");
  expect(() =>
    sourceArtifacts(
      { packages: [{ name: "sample", downloadLocation: "https://example.org/source" }] },
      "sample",
    ),
  ).toThrow("Missing pinned");
});
