import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { VmRuntime } from "./runtime.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-recovery-"));
  homes.push(home);
  const directory = join(home, "instances", "instance");
  await mkdir(directory, { recursive: true });
  return { runtime: new VmRuntime({ home }), directory };
}
test("missing receipt and live writer PID cannot authorize cleanup", async () => {
  const { runtime, directory } = await fixture();
  expect(await runtime.reconcile("instance")).toBe(false);
  await writeFile(
    join(directory, "exit-receipt.json"),
    JSON.stringify({ instanceId: "instance", pid: process.pid }),
  );
  expect(await runtime.reconcile("instance")).toBe(false);
  expect(await runtime.hasWorkDirectory("instance")).toBe(true);
});
test("verified exit receipt allows cleanup but a mismatched instance does not", async () => {
  const { runtime, directory } = await fixture();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "close");
  await writeFile(
    join(directory, "exit-receipt.json"),
    JSON.stringify({ instanceId: "other", pid: child.pid }),
  );
  expect(await runtime.reconcile("instance")).toBe(false);
  await writeFile(
    join(directory, "exit-receipt.json"),
    JSON.stringify({ instanceId: "instance", pid: child.pid }),
  );
  expect(await runtime.reconcile("instance")).toBe(true);
  expect(await runtime.hasWorkDirectory("instance")).toBe(false);
});
