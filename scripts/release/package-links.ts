import { readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export async function relocatePackageLinks(source: string, destination: string) {
  const sourceRoot = await realpath(source);
  const destinationRoot = await realpath(destination);
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) {
        const target = await realpath(resolve(dirname(path), await readlink(path)));
        const relocated = target.startsWith(sourceRoot + sep)
          ? join(destinationRoot, relative(sourceRoot, target))
          : target;
        if (!relocated.startsWith(destinationRoot + sep))
          throw new Error(`External dependency link in package: ${path}`);
        if (target !== relocated) {
          await unlink(path);
          await symlink(relative(dirname(path), relocated), path);
        }
      }
    }
  }
  await visit(destinationRoot);
  await verifyPackageLinks(destinationRoot);
}
export async function verifyPackageLinks(directory: string) {
  const root = await realpath(directory);
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink() && !(await realpath(path)).startsWith(root + sep))
        throw new Error(`External dependency link in package: ${path}`);
    }
  }
  await visit(root);
}
