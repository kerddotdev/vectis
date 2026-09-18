import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { Snapshot } from "../packages/protocol/src/index.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: pnpm package:verify <portable-package-directory>");
const cli = join(resolve(path), "bin", "vectis");
const home = await mkdtemp(join(tmpdir(), "vectis-package-check-"));
const execute = promisify(execFile);
async function command(args: string[]) {
  const result = await execute(cli, [...args, "--home", home, "--json"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
    timeout: 30000,
  });
  const value: unknown = JSON.parse(result.stdout);
  return value;
}
const snapshot = async () => Schema.decodeUnknownSync(Snapshot)(await command(["status"]));
async function waitForStop() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await access(join(home, "service.lock"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}
let started = false;
let stopped = false;
try {
  await command(["service", "start"]);
  started = true;
  const initial = await snapshot();
  await command(["pause", "--wait"]);
  if (!(await snapshot()).machine.paused) throw new Error("Packaged service did not pause.");
  await command(["service", "stop"]);
  started = false;
  if (!(await waitForStop())) throw new Error("Packaged service did not stop before restart.");
  await command(["service", "start"]);
  started = true;
  const restored = await snapshot();
  if (!restored.machine.paused || restored.machine.id !== initial.machine.id)
    throw new Error("Packaged service did not retain its durable state.");
  const mcp = new Client({ name: "vectis-package-check", version: "1" });
  try {
    await mcp.connect(
      new StdioClientTransport({
        command: join(resolve(path), "bin", "vectis-mcp"),
        args: ["--home", home],
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
      }),
    );
    const status = await mcp.callTool({ name: "vectis_status", arguments: {} });
    if (status.isError) throw new Error("Packaged MCP status failed.");
    const result = Schema.decodeUnknownSync(Schema.Struct({ result: Snapshot }))(
      status.structuredContent,
    );
    if (result.result.machine.id !== initial.machine.id || !result.result.machine.paused)
      throw new Error("Packaged MCP does not reflect the same service state.");
  } finally {
    await mcp.close();
  }
  await command(["resume", "--wait"]);
  if ((await snapshot()).machine.paused) throw new Error("Packaged service did not resume.");
  console.log(
    "PASS: standalone package starts without Node on PATH, serves CLI and MCP commands, and retains state across restart.",
  );
} finally {
  if (started) await command(["service", "stop"]);
  stopped = await waitForStop();
  if (stopped) await rm(home, { recursive: true });
}

if (!stopped)
  throw new Error(`Package test service did not stop; isolated state retained at ${home}.`);
