// General Sans is licensed under the ITF Free Font License, which forbids
// redistributing the font files through a repository. Builds download the
// official, unmodified files from Fontshare instead of committing them.
import { join } from "node:path";
import { cachedFonts, downloadFonts } from "./font-artifact.mjs";

const target = join(import.meta.dirname, "fonts", "general-sans");
if (!(await cachedFonts(target))) {
  try {
    await downloadFonts(target);
    console.log("Downloaded verified General Sans from Fontshare.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env.VECTIS_ALLOW_FONT_FALLBACK !== "1") {
      console.error(
        `General Sans could not be downloaded: ${reason}\nSet VECTIS_ALLOW_FONT_FALLBACK=1 to build with system fonts.`,
      );
      process.exitCode = 1;
    } else console.warn(`General Sans unavailable, using system fonts: ${reason}`);
  }
}
