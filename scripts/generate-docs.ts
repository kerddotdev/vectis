import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = join(root, "apps/docs");
await mkdir(join(docs, "public"), { recursive: true });
await copyFile(join(root, "assets/brand/web/vectis.svg"), join(docs, "public/icon.svg"));
const { stdout } = await promisify(execFile)(process.execPath, [
  join(root, "dist/apps/cli/src/main.js"),
  "--help",
]);
const reference = join(docs, "docs/reference/cli.md");
await mkdir(dirname(reference), { recursive: true });
await writeFile(
  reference,
  `---\ntitle: CLI reference\ndescription: Command help generated from the current CLI.\n---\n\nThis reference is generated from the built CLI during the docs build. In a source checkout, use \`pnpm vectis\` in place of \`vectis\`.\n\n\`\`\`text\n${stdout}\`\`\`\n`,
);
