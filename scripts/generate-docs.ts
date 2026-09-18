import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = join(root, "apps/docs");
const source = join(docs, "src/content/docs");
await cp(join(root, "assets/brand/web"), join(docs, "public/brand"), { recursive: true });
const { stdout } = await promisify(execFile)(process.execPath, [
  join(root, "dist/apps/cli/src/main.js"),
  "--help",
]);
const reference = join(source, "reference/cli.md");
await mkdir(dirname(reference), { recursive: true });
await writeFile(
  reference,
  `---\ntitle: CLI reference\ndescription: Command help generated from the current CLI.\n---\n\nThis reference is generated from the built CLI during the docs build. In a source checkout, use \`pnpm vectis\` in place of \`vectis\`.\n\n\`\`\`text\n${stdout}\`\`\`\n`,
);

const markdown = join(docs, "public/markdown");
await rm(markdown, { recursive: true, force: true });
const links: string[] = [];
async function publish(directory: string, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink())
      throw new Error("Public documentation cannot contain symbolic links.");
    const path = join(directory, entry.name);
    const name = relative + entry.name;
    if (entry.isDirectory()) await publish(path, name + "/");
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const contents = await readFile(path, "utf8");
      const target = join(markdown, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
      const title = /^title: (.+)$/m.exec(contents)?.[1] ?? name;
      links.push(`- [${title}](https://vectis.kerd.dev/docs/markdown/${name})`);
    }
  }
}
await publish(source);
await writeFile(
  join(docs, "public/llms.txt"),
  `# Vectis\n\n> Local virtual machines for GitHub Actions. This is a development build; use capability discovery before changing state.\n\n## Documentation\n\n${links.join("\n")}\n`,
);
