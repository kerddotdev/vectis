import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { Diagnostics } from "../packages/protocol/src/diagnostics.js";
import { Snapshot } from "../packages/protocol/src/index.js";
import { StorageReport } from "../packages/protocol/src/storage.js";

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
  const doctor = Schema.decodeUnknownSync(Diagnostics)(await command(["doctor"]));
  if (!doctor.configured.appleHelper || !doctor.configured.keychainHelper)
    throw new Error("Packaged Apple helpers were not configured automatically.");
  const windows = (
    await Promise.all(
      ["runtime", "Vectis Runtime.app/Contents/Resources/runtime"].map((runtime) =>
        access(join(resolve(path), runtime, "windows/bin/qemu-system-aarch64")).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).some(Boolean);
  if (
    windows &&
    (!doctor.configured.qemu || !doctor.configured.qemuImg || !doctor.configured.swtpm)
  )
    throw new Error("Packaged Windows runtime was not configured automatically.");
  const disk = join(home, "inspection-fixture.img");
  const definition = join(home, "inspection-fixture.json");
  await writeFile(disk, "isolated storage fixture");
  await writeFile(
    definition,
    JSON.stringify({
      id: "inspection-fixture",
      name: "Package inspection fixture",
      os: "linux",
      basePath: disk,
      cpu: 1,
      memoryMiB: 512,
      state: "ready",
    }),
  );
  await command(["environment", "register", "--file", definition, "--wait"]);
  const storage = Schema.decodeUnknownSync(StorageReport)(await command(["storage"]));
  const usage = storage.environments.find(
    (environment) => environment.environmentId === "inspection-fixture",
  )?.base;
  if (
    usage?.status !== "available" ||
    usage.fileBytes !== Buffer.byteLength("isolated storage fixture")
  )
    throw new Error("Packaged storage worker did not inspect the isolated fixture.");
  await command(["environment", "remove", "inspection-fixture", "--wait"]);
  await command(["pause", "--wait"]);
  if (!(await snapshot()).machine.paused) throw new Error("Packaged service did not pause.");
  await command(["service", "stop", "--if-idle"]);
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
