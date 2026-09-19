import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VectisError } from "../../../packages/protocol/src/index.js";

const marker = "# Installed by Vectis.";
const tools = ["vectis", "vectis-mcp"] as const;

export const commandLineDirectory = () => join(homedir(), ".local", "bin");

function shim(target: string) {
  return `#!/bin/sh\n${marker} Runs the command line tool inside the app.\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`;
}

async function existing(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// GUI apps inherit launchd's PATH, so ask the user's login shell which PATH their terminals get.
export async function shellPath(signal = AbortSignal.timeout(5000)) {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(shell, ["-ilc", 'printf "\\nVECTIS_PATH=%s\\n" "$PATH"'], {
      stdio: ["ignore", "pipe", "ignore"],
      signal,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = (output + chunk).slice(-65536);
    });
    child.once("error", () => resolve(undefined));
    child.once("close", () => resolve(/\nVECTIS_PATH=(.*)\n/.exec(output)?.[1]));
  });
}

export async function commandLineStatus(
  resources: string,
  directory = commandLineDirectory(),
  path: string | undefined = undefined,
) {
  const installed = await Promise.all(
    tools.map(
      async (tool) =>
        (await existing(join(directory, tool))) === shim(join(resources, "bin", tool)),
    ),
  );
  return {
    directory,
    installed: installed.every(Boolean),
    onPath: path === undefined ? undefined : path.split(":").includes(directory),
  };
}

export async function installCommandLine(resources: string, directory = commandLineDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const tool of tools) {
    const destination = join(directory, tool);
    const current = await existing(destination);
    if (current !== undefined && !current.includes(marker))
      throw new VectisError(
        "command_line_conflict",
        `${destination} exists and was not installed by Vectis.`,
        "Remove or rename it, then install the command line tools again.",
      );
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, shim(join(resources, "bin", tool)), { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  }
}
