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

// The help text is grouped under unindented headings; each group becomes a section.
const sections: { title: string; lines: string[] }[] = [];
for (const line of stdout.trimEnd().split("\n").slice(3)) {
  if (line && !line.startsWith(" ")) sections.push({ title: line, lines: [] });
  else sections.at(-1)?.lines.push(line);
}
const body = sections
  .map(({ title, lines }) => {
    const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
    return text ? `## ${title}\n\n\`\`\`text\n${text}\n\`\`\`` : `${title}`;
  })
  .join("\n\n");
const reference = join(docs, "docs/reference/cli.md");
await mkdir(dirname(reference), { recursive: true });
await writeFile(
  reference,
  `---\ntitle: CLI reference\ndescription: Every vectis command and option, generated from the CLI help.\n---\n\nThis page is generated from \`vectis --help\` when the documentation is built. Install the command line tools from the app as described in [Install Vectis](/docs/get-started/install#command-line-tools). In a source checkout, run \`pnpm vectis\` instead. See [Operations and output](/docs/reference/operations) for keys, waiting, exit codes and errors.\n\n${body}\n`,
);
