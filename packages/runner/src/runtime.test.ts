import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { VmRuntime } from "./runtime.js";

vi.mock("./memory.js", () => ({ availableHostMemory: async () => 8 * 1024 ** 3 }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const hostTest = test.skipIf(process.platform !== "darwin" || process.arch !== "arm64");
async function fixture(script: string) {
  const home = await mkdtemp(join(tmpdir(), "vectis-runtime-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const helper = join(home, "helper");
  await writeFile(helper, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  const basePath = join(home, "base.img");
  await writeFile(basePath, "untouched-base");
  const runtime = new VmRuntime({ home, appleHelper: helper });
  cleanups.push(() => runtime.close());
  const environment = {
    id: "test",
    name: "Test",
    os: "linux" as const,
    state: "ready" as const,
    basePath,
    cpu: 1,
    memoryMiB: 512,
  };
  return { home, runtime, environment };
}
hostTest("natural VM exit removes its disposable disk and preserves the base", async () => {
  const { home, runtime, environment } = await fixture(
    'process.stdout.write(\'{"event":"vm.running"}\\n\'); setTimeout(() => process.exit(0), 100);',
  );
  let cleaned = false;
  const instance = await runtime.start("natural", environment, (value) => {
    cleaned = value;
  });
  await instance.settled;
  expect(cleaned).toBe(true);
  await expect(stat(join(home, "instances", "natural"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(environment.basePath, "utf8")).toBe("untouched-base");
});
hostTest("failed startup reaps the helper and removes the work disk", async () => {
  const { runtime, environment } = await fixture(
    'process.stdout.write(\'{"event":"vm.error"}\\n\'); setInterval(() => {}, 1000);',
  );
  await expect(runtime.start("failed", environment, () => {})).rejects.toMatchObject({
    code: "vm_start_failed",
  });
  expect(await runtime.hasWorkDirectory("failed")).toBe(false);
});
hostTest("explicit stop waits for process exit and cleanup", async () => {
  const { runtime, environment } = await fixture(
    'process.stdout.write(\'{"event":"vm.running"}\\n\'); setInterval(() => {}, 1000);',
  );
  const instance = await runtime.start("stop", environment, () => {});
  await runtime.stop(instance.id);
  expect(instance.process.signalCode).toBe("SIGTERM");
  expect(await runtime.hasWorkDirectory(instance.id)).toBe(false);
});

hostTest(
  "custom VM storage is separate from service state and cleanup preserves its parent",
  async () => {
    const { home, runtime, environment } = await fixture(
      'process.stdout.write(\'{"event":"vm.running"}\\n\'); setInterval(() => {}, 1000);',
    );
    const storagePath = join(home, "selected-volume");
    await mkdir(storagePath);
    const instance = await runtime.start("custom", { ...environment, storagePath }, () => {});
    expect(instance.directory).toBe(join(storagePath, "custom"));
    expect(await runtime.hasWorkDirectory("custom", instance.directory)).toBe(true);
    await runtime.stop(instance.id);
    expect(await runtime.hasWorkDirectory("custom", instance.directory)).toBe(false);
    expect((await stat(storagePath)).isDirectory()).toBe(true);
  },
);

hostTest(
  "missing selected storage never falls back to creating a directory on the host",
  async () => {
    const { home, runtime, environment } = await fixture("process.exit(99);");
    const storagePath = join(home, "disconnected-volume", "vms");
    await expect(
      runtime.start("missing", { ...environment, storagePath }, () => {}),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    await expect(stat(join(home, "disconnected-volume"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
