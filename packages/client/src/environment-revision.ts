import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "../../protocol/src/index.js";

export async function environmentRevision(environment: Environment): Promise<string | undefined> {
  const paths =
    environment.os === "macos"
      ? ["disk.img", "hardware-model.bin", "machine-identifier.bin", "auxiliary-storage.bin"].map(
          (name) => join(environment.basePath, name),
        )
      : [environment.basePath];
  if (environment.firmwarePath) paths.push(environment.firmwarePath);
  if (environment.firmwareVarsPath) paths.push(environment.firmwareVarsPath);
  try {
    const files = await Promise.all(
      paths.map(async (path) => {
        const canonical = await realpath(path);
        const info = await stat(canonical, { bigint: true });
        if (!info.isFile()) throw new Error("Image component is not a regular file.");
        return [canonical, info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString()];
      }),
    );
    const configuration = Object.entries(environment).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return createHash("sha256").update(JSON.stringify({ configuration, files })).digest("hex");
  } catch {
    return undefined;
  }
}
