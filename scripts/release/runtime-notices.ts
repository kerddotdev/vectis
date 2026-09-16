import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const licenseName =
  /^(?:COPYING|COPYRIGHT|LICEN[CS]E|NOTICE)(?:[._-].*)?$|^(?:L?GPL|BSD|MIT|Apache).*\.txt$/i;
const supportingName = /^(?:AUTHORS|README)(?:[._-].*)?$|^sbom\.spdx\.json$/i;

export async function stageRuntimeNotices(sources: readonly string[], output: string) {
  const formulas = new Map<string, { name: string; version: string }>();
  for (const source of sources) {
    const match = source.match(/^(.*\/Cellar\/([^/]+)\/([^/]+))\//);
    if (match?.[1] && match[2] && match[3])
      formulas.set(match[1], { name: match[2], version: match[3] });
  }
  const notices: { name: string; version: string; files: string[] }[] = [];
  for (const [root, formula] of formulas) {
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries
      .filter(
        (entry) =>
          entry.isFile() && (licenseName.test(entry.name) || supportingName.test(entry.name)),
      )
      .map((entry) => entry.name)
      .sort();
    if (!names.some((name) => licenseName.test(name)))
      throw new Error(`Installed license materials are missing for ${formula.name}.`);
    const directory = join("licenses", "homebrew", formula.name, formula.version);
    await mkdir(join(output, directory), { recursive: true });
    for (const name of names) await copyFile(join(root, name), join(output, directory, name));
    notices.push({ ...formula, files: names.map((name) => join(directory, name)) });
  }
  return notices;
}
