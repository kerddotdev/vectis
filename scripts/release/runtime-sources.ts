import { Schema } from "effect";

const Spdx = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      downloadLocation: Schema.optional(Schema.String),
      checksums: Schema.optional(
        Schema.Array(
          Schema.Struct({
            algorithm: Schema.String,
            checksumValue: Schema.String,
          }),
        ),
      ),
    }),
  ),
});

export function sourceArtifacts(input: unknown, formula: string) {
  const document = Schema.decodeUnknownSync(Spdx)(input);
  const sources = document.packages.filter(
    (entry) => entry.name === formula || entry.name.startsWith(`${formula} patch `),
  );
  const result: { name: string; url: string; sha256: string }[] = [];
  for (const entry of sources) {
    if (entry.downloadLocation?.startsWith("https://ghcr.io/")) continue;
    const url = new URL(entry.downloadLocation ?? "invalid");
    const sha256 = entry.checksums?.find(
      (checksum) => checksum.algorithm === "SHA256",
    )?.checksumValue;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !sha256 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw new Error(`Missing pinned HTTPS source for ${entry.name}.`);
    result.push({ name: entry.name, url: url.href, sha256 });
  }
  if (!result.some((entry) => entry.name === formula))
    throw new Error(`Missing upstream source for ${formula}.`);
  return result;
}
