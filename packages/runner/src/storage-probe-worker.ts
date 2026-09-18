import { access, mkdir, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";

const [, , source, directory, create] = process.argv;
if (!source || !directory) throw new Error("Storage probe requires image and directory paths.");
if (create === "create") await mkdir(directory, { recursive: true, mode: 0o700 });
const folder = await opendir(directory);
try {
  await folder.read();
} finally {
  await folder.close();
}
await access(directory, constants.W_OK | constants.X_OK);
const file = await open(source, "r");
try {
  if (!(await file.stat()).isFile()) throw new Error("Expected a regular image file.");
  await file.read(Buffer.alloc(1), 0, 1, 0);
} finally {
  await file.close();
}
process.stdout.write("accessible");
