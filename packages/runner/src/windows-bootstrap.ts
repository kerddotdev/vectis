import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";
import { executeGuest, type GuestConnection } from "./guest.js";

const Diagnostic = Schema.Struct({
  stage: Schema.Literals([
    "system",
    "ssh-installation",
    "ssh-configuration",
    "ssh-access",
    "git-download",
    "git-checksum",
    "git-installation",
    "git-verification",
    "toolchain",
    "completion",
  ]),
  message: Schema.String,
  line: Schema.Number,
});

export async function windowsBootstrapFailure(
  connection: GuestConnection,
  directory: string,
  signal: AbortSignal,
) {
  let stage: string | undefined;
  try {
    const result = await executeGuest(
      connection,
      "Get-Content C:\\ProgramData\\Vectis\\diagnostic.json -Raw",
      { signal, shell: "powershell" },
    );
    if (result.exitCode === 0 && !result.truncated) {
      const diagnostic = Schema.decodeUnknownSync(Diagnostic)(JSON.parse(result.stdout));
      await writeFile(
        join(directory, "bootstrap-diagnostic.json"),
        JSON.stringify({ ...diagnostic, message: diagnostic.message.slice(0, 4096) }),
        { mode: 0o600 },
      );
      stage = diagnostic.stage;
    }
  } catch {
    // Diagnostics must not hide the bootstrap failure, including with older setup media.
  }
  return new VectisError(
    "guest_preparation_failed",
    `Windows bootstrap reported a failure${stage ? ` during ${stage}` : ""}. Inspect private setup diagnostics before resuming.`,
  );
}
