// General Sans is licensed under the ITF Free Font License, which forbids
// redistributing the font files through a repository. Builds download the
// official, unmodified files from Fontshare instead of committing them.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const target = join(import.meta.dirname, "fonts", "general-sans");
const files = ["GeneralSans-Variable.woff2", "GeneralSans-VariableItalic.woff2", "FFL.txt"];

if (!files.every((file) => existsSync(join(target, file)))) {
  const scratch = await mkdtemp(join(tmpdir(), "vectis-fonts-"));
  try {
    const response = await fetch("https://api.fontshare.com/v2/fonts/download/general-sans", {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Fontshare responded with ${response.status}.`);
    const archive = join(scratch, "general-sans.zip");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await mkdir(target, { recursive: true });
    await promisify(execFile)("unzip", [
      "-j",
      "-o",
      archive,
      "*/Fonts/WEB/fonts/GeneralSans-Variable.woff2",
      "*/Fonts/WEB/fonts/GeneralSans-VariableItalic.woff2",
      "*/License/FFL.txt",
      "-d",
      target,
    ]);
    console.log("Downloaded General Sans from Fontshare.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env.VECTIS_ALLOW_FONT_FALLBACK !== "1") {
      console.error(
        `General Sans could not be downloaded: ${reason}\nSet VECTIS_ALLOW_FONT_FALLBACK=1 to build with system fonts.`,
      );
      process.exitCode = 1;
    } else console.warn(`General Sans unavailable, using system fonts: ${reason}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
