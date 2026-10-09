import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const archivePin = {
  bytes: 2270724,
  sha256: "3e621ae2f3b04e5697d647d35ce0ccc1d7facb85e70799441b1a21229d03e4ab",
};
export const fontPins = [
  {
    name: "GeneralSans-Variable.woff2",
    member: "GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-Variable.woff2",
    bytes: 38132,
    sha256: "49d3fbd2f1bcc9850d8d939cabf107d6ade508ce08419fca466b06879e4a0a8e",
  },
  {
    name: "GeneralSans-VariableItalic.woff2",
    member: "GeneralSans_Complete/Fonts/WEB/fonts/GeneralSans-VariableItalic.woff2",
    bytes: 40728,
    sha256: "5caa1d9baebac52533458016a982cc699a6992c956054ce8e4d5cf51814ce28b",
  },
  {
    name: "FFL.txt",
    member: "GeneralSans_Complete/License/FFL.txt",
    bytes: 12734,
    sha256: "145e7fe2429a3336ba215c070ef722000e01348a3e1baaa127e871bb5012f554",
  },
];
export function verifyBytes(bytes, pin) {
  if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
    throw new Error("Font artifact does not match its pinned size and SHA-256.");
}
export async function fontDirectory(target) {
  for (const directory of [dirname(target), target]) {
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Font directories must not be symbolic links.");
  }
}
export async function cachedFonts(target) {
  await fontDirectory(target);
  let complete = true;
  for (const pin of fontPins) {
    let file;
    try {
      file = await open(
        join(target, pin.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      complete = false;
      continue;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== pin.bytes) throw new Error("Invalid cached font file.");
      verifyBytes(await file.readFile(), pin);
    } finally {
      await file.close();
    }
  }
  return complete;
}
export async function downloadFonts(target, request = fetch) {
  await fontDirectory(target);
  const scratch = await mkdtemp(join(tmpdir(), "vectis-fonts-"));
  try {
    const response = await request("https://api.fontshare.com/v2/fonts/download/general-sans", {
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel();
      throw new Error("Fontshare download failed.");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > archivePin.bytes) {
          await reader.cancel();
          throw new Error("Font archive exceeds its pinned size.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    verifyBytes(bytes, archivePin);
    const archive = join(scratch, "general-sans.zip");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    const verified = [];
    for (const pin of fontPins) {
      // Read member bytes without materializing archive paths or links on the build host.
      const { stdout } = await promisify(execFile)("unzip", ["-p", archive, pin.member], {
        encoding: "buffer",
        maxBuffer: pin.bytes + 1,
        timeout: 10000,
      });
      verifyBytes(stdout, pin);
      verified.push({ pin, bytes: stdout });
    }
    for (const { pin, bytes } of verified) {
      const path = join(target, pin.name);
      try {
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!(await cachedFonts(target))) throw new Error("Font download is incomplete.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
