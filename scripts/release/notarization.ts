import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";

export async function notarizationArguments(profile?: string, environment = process.env) {
  if (profile) return ["--keychain-profile", profile];
  const key = environment.APPLE_API_KEY;
  const keyId = environment.APPLE_API_KEY_ID;
  const issuer = environment.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer || !isAbsolute(key))
    throw new Error(
      "Provide --keychain-profile or APPLE_API_KEY (absolute path), APPLE_API_KEY_ID and APPLE_API_ISSUER.",
    );
  await access(key);
  return ["--key", key, "--key-id", keyId, "--issuer", issuer];
}

export async function notarizeBundle(
  app: string,
  authentication: string[],
  kind: "app" | "disk-image" = "app",
) {
  const run = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "vectis-notarization-"));
  try {
    const archive = kind === "app" ? join(root, "application.zip") : app;
    if (kind === "app") await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
    const { stdout } = await run(
      "/usr/bin/xcrun",
      ["notarytool", "submit", archive, ...authentication, "--wait", "--output-format", "json"],
      { timeout: 1800000 },
    );
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, status: Schema.String }),
    )(JSON.parse(stdout));
    if (result.status !== "Accepted")
      throw new Error(
        `Apple notarization ${result.status}; submission ${result.id}. Inspect its notarytool log before retrying.`,
      );
    await run("/usr/bin/xcrun", ["stapler", "staple", app]);
    await run("/usr/bin/xcrun", ["stapler", "validate", app]);
    await run(
      "/usr/sbin/spctl",
      kind === "app"
        ? ["--assess", "--type", "execute", app]
        : ["--assess", "--type", "open", "--context", "context:primary-signature", app],
    );
    return { id: result.id, status: "Accepted" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
