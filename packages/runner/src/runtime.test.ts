import { mkdtemp, mkdir, writeFile, rm, readFile, stat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { VmRuntime } from "./runtime.js";
import { readyGuest } from "./guest-ready.js";
vi.mock("./guest-ready.js", () => ({ readyGuest: vi.fn() }));

vi.mock("./memory.js", () => ({ availableHostMemory: async () => 8 * 1024 ** 3 }));

const failedRemovals = vi.hoisted(() => new Set<string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const [path] = args;
      if (typeof path === "string" && failedRemovals.delete(path)) {
        await fs.rm(path, { recursive: true, force: true });
        await fs.mkdir(path);
        await fs.writeFile(join(path, ".DS_Store"), "Finder metadata");
        throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
      }
      return fs.rm(...args);
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  failedRemovals.clear();
  vi.resetAllMocks();
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
hostTest.each(["linux", "macos"] as const)(
  "%s provisioning writes in place and cleans only its supervisory directory",
  async (os) => {
    const { home, runtime, environment } = await fixture(
      `const fs = require('node:fs'); const path = require('node:path'); const image = process.argv[4]; const disk = process.argv[3] === 'macos' ? path.join(image, 'disk.img') : image; fs.writeFileSync(disk, 'provisioned'); process.stdout.write('{"event":"vm.running"}\\n'); setInterval(() => {}, 1000);`,
    );
    const basePath = os === "macos" ? join(home, "base.bundle") : environment.basePath;
    if (os === "macos") {
      await mkdir(basePath);
      await writeFile(join(basePath, "disk.img"), "parent-clone");
    }
    const configured = { ...environment, os, basePath };
    const instance = await runtime.start("in-place", configured, () => {}, undefined, {
      diskInPlace: true,
    });
    await runtime.stop(instance.id);
    expect(await readFile(os === "macos" ? join(basePath, "disk.img") : basePath, "utf8")).toBe(
      "provisioned",
    );
    expect(await runtime.hasWorkDirectory(instance.id)).toBe(false);
  },
);
hostTest(
  "Windows in-place provisioning preserves guest writes to its disk, UEFI variables and TPM",
  async () => {
    const { home, runtime, environment } = await fixture("process.exit(99);");
    const qemu = join(home, "fake-qemu.cjs");
    const swtpm = join(home, "fake-swtpm.cjs");
    await writeFile(
      qemu,
      `#!${process.execPath}
if (process.argv.includes('-vectis-isolation-version')) { console.log('1'); process.exit(0); }
const fs = require('node:fs');
fs.writeFileSync('disk.qcow2', 'new-disk');
fs.writeFileSync('uefi-vars.fd', 'new-vars');
fs.writeFileSync('tpm/state', 'new-tpm');
console.log(JSON.stringify({QMP:{}}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const {id, execute} = JSON.parse(line);
  if (execute === 'system_powerdown') {
    console.log(JSON.stringify({id, return:{}}));
    setTimeout(() => process.exit(0), 50);
    return;
  }
  console.log(JSON.stringify({id, return: id === 'status' ? {running:true} : id === 'network' ? 'TCP[HOST_FORWARD] 1 127.0.0.1 12345 10.0.2.15 22 0 0' : {}}));
});
`,
      { mode: 0o700 },
    );
    await writeFile(
      swtpm,
      `#!${process.execPath}\nrequire('node:net').createServer().listen('tpm.sock');`,
      { mode: 0o700 },
    );
    const firmwareVarsPath = join(home, "uefi-vars.fd");
    const tpmStatePath = join(home, "tpm");
    await writeFile(firmwareVarsPath, "old-vars");
    await mkdir(tpmStatePath);
    await writeFile(join(tpmStatePath, "state"), "old-tpm");
    const windows = new VmRuntime({ home, qemu, qemuImg: "/must-not-run-qemu-img", swtpm });
    cleanups.push(() => windows.close());
    const instance = await windows.start(
      "windows-in-place",
      {
        ...environment,
        os: "windows",
        firmwarePath: join(home, "code.fd"),
        firmwareVarsPath,
        tpmStatePath,
      },
      () => {},
      undefined,
      { diskInPlace: true },
    );
    const kill = vi.spyOn(instance.process, "kill");
    expect(await windows.requestShutdown(instance.id)).toBe(true);
    await instance.settled;
    expect(instance.process.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(await readFile(environment.basePath, "utf8")).toBe("new-disk");
    expect(await readFile(firmwareVarsPath, "utf8")).toBe("new-vars");
    expect(await readFile(join(tpmStatePath, "state"), "utf8")).toBe("new-tpm");
    expect(await runtime.hasWorkDirectory(instance.id)).toBe(false);
  },
);
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

hostTest.each(["linux", "macos"] as const)(
  "%s graceful request waits for natural exit without forcing",
  async (os) => {
    const { runtime, environment } = await fixture(`
console.log(JSON.stringify({event:'vm.running'}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  if (line !== 'shutdown') process.exit(97);
  console.log(JSON.stringify({event:'vm.shutdown_requested'}));
  setTimeout(() => process.exit(0), 50);
});`);
    const basePath = os === "macos" ? join(environment.basePath + ".bundle") : environment.basePath;
    if (os === "macos") {
      await mkdir(basePath);
      await writeFile(join(basePath, "disk.img"), "synthetic disk");
    }
    const instance = await runtime.start(
      "graceful",
      { ...environment, os, basePath },
      () => {},
      undefined,
      { diskInPlace: true },
    );
    const kill = vi.spyOn(instance.process, "kill");
    expect(await runtime.requestShutdown(instance.id)).toBe(true);
    expect(instance.process.exitCode).toBeNull();
    await instance.settled;
    expect(instance.process.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(await runtime.hasWorkDirectory(instance.id)).toBe(false);
    await expect(runtime.requestShutdown(instance.id)).rejects.toMatchObject({ code: "not_owned" });
  },
);

hostTest(
  "partial cleanup preserves exit evidence so Finder residue can be reconciled",
  async () => {
    const { runtime, environment } = await fixture(
      'process.stdout.write(\'{"event":"vm.running"}\\n\'); setInterval(() => {}, 1000);',
    );
    const onExit = vi.fn();
    const instance = await runtime.start("residual", environment, onExit);
    failedRemovals.add(instance.directory);
    await expect(runtime.stop(instance.id)).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(onExit).toHaveBeenCalledWith(false);
    expect(
      JSON.parse(await readFile(join(instance.directory, "exit-receipt.json"), "utf8")),
    ).toEqual({
      instanceId: instance.id,
      pid: instance.process.pid,
    });
    expect(await readFile(join(instance.directory, ".DS_Store"), "utf8")).toBe("Finder metadata");
    failedRemovals.add(instance.directory);
    expect(await runtime.reconcile(instance.id, instance.directory)).toBe(false);
    expect(
      JSON.parse(await readFile(join(instance.directory, "exit-receipt.json"), "utf8")),
    ).toEqual({
      instanceId: instance.id,
      pid: instance.process.pid,
    });
    expect(await runtime.reconcile(instance.id, instance.directory)).toBe(true);
    expect(await runtime.hasWorkDirectory(instance.id, instance.directory)).toBe(false);
    expect(await readFile(environment.basePath, "utf8")).toBe("untouched-base");
  },
);

hostTest("failed startup does not discard exit evidence after partial cleanup", async () => {
  const { runtime, environment } = await fixture(
    'process.stdout.write(\'{"event":"vm.error"}\\n\'); setInterval(() => {}, 1000);',
  );
  const directory = runtime.directoryFor("startup-residual", environment);
  failedRemovals.add(directory);
  await expect(runtime.start("startup-residual", environment, () => {})).rejects.toMatchObject({
    code: "ENOTEMPTY",
  });
  expect(await readFile(join(directory, ".DS_Store"), "utf8")).toBe("Finder metadata");
  expect(await runtime.reconcile("startup-residual", directory)).toBe(true);
  expect(await runtime.hasWorkDirectory("startup-residual", directory)).toBe(false);
});

hostTest("startup cancellation terminates an owned helper before readiness", async () => {
  const { home, runtime, environment } = await fixture(
    'require("node:fs").writeFileSync(require("node:path").join(__dirname, "started"), String(process.pid)); setInterval(() => {}, 1000);',
  );
  const abort = new AbortController();
  const result = runtime.start("cancel", environment, () => {}, abort.signal);
  const rejected = expect(result).rejects.toBeInstanceOf(Error);
  await vi.waitFor(async () =>
    expect(await readFile(join(home, "started"), "utf8")).toMatch(/^\d+$/),
  );
  abort.abort();
  await rejected;
  expect(await runtime.hasWorkDirectory("cancel")).toBe(false);
  const pid = Number(await readFile(join(home, "started"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
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

hostTest("native cloning preserves sparse disks and isolates guest writes", async () => {
  const { home, runtime, environment } = await fixture(
    'process.stdout.write(\'{"event":"vm.running"}\\n\'); setInterval(() => {}, 1000);',
  );
  const sparse = await open(environment.basePath, "r+");
  try {
    await sparse.truncate(64 * 1024 ** 2);
  } finally {
    await sparse.close();
  }
  const before = await stat(environment.basePath);
  const instance = await runtime.start("sparse", environment, () => {});
  const disk = join(home, "instances", "sparse", "disk.img");
  const copied = await stat(disk);
  expect(copied.size).toBe(before.size);
  expect(copied.blocks).toBeLessThan(2048);
  const work = await open(disk, "r+");
  try {
    await work.write("guest-write", 0, "utf8");
  } finally {
    await work.close();
  }
  const base = await open(environment.basePath, "r");
  try {
    const bytes = Buffer.alloc(14);
    await base.read(bytes, 0, bytes.length, 0);
    expect(bytes.toString()).toBe("untouched-base");
  } finally {
    await base.close();
  }
  await runtime.stop(instance.id);
});

hostTest(
  "default instance storage permissions are checked before creating a VM directory",
  async () => {
    const { chmod } = await import("node:fs/promises");
    const { home, runtime, environment } = await fixture("process.exit(0);");
    const instances = join(home, "instances");
    await mkdir(instances, { mode: 0o000 });
    try {
      await expect(runtime.start("denied", environment, () => {})).rejects.toMatchObject({
        code: "storage_access_required",
      });
    } finally {
      await chmod(instances, 0o700);
    }
    expect(await runtime.hasWorkDirectory("denied")).toBe(false);
  },
);

hostTest.each([undefined, "rosetta"] as const)(
  "Apple startup passes x64=%s only when enabled",
  async (x64) => {
    const { home, runtime, environment } = await fixture(
      `require("node:fs").writeFileSync(require("node:path").join(__dirname, "args.json"), JSON.stringify(process.argv.slice(2))); process.stdout.write('{"event":"vm.running","macAddress":"02:00:00:00:00:01"}\\n'); setInterval(() => {}, 1000);`,
    );
    const seedPath = join(home, "seed.img");
    await writeFile(seedPath, "synthetic seed");
    vi.mocked(readyGuest).mockResolvedValue({
      host: "192.168.64.2",
      port: 22,
      user: "vectis",
      identityFile: "/synthetic/key",
      knownHostsFile: "/synthetic/hosts",
      hostKeyAlias: "test",
    });
    const instance = await runtime.start(
      "args",
      { ...environment, seedPath, ...(x64 ? { x64 } : {}) },
      () => {},
    );
    expect(JSON.parse(await readFile(join(home, "args.json"), "utf8"))).toEqual([
      "run",
      "linux",
      join(instance.directory, "disk.img"),
      "1",
      "512",
      join(instance.directory, "efi.bin"),
      seedPath,
      ...(x64 ? ["--rosetta"] : []),
    ]);
    if (x64) expect(readyGuest).toHaveBeenCalledOnce();
    else expect(readyGuest).not.toHaveBeenCalled();
    await runtime.stop(instance.id);
  },
);

hostTest(
  "missing Rosetta guest support stops the owned helper and removes its work directory",
  async () => {
    const { runtime, environment } = await fixture(
      `process.stdout.write('{"event":"vm.running","macAddress":"02:00:00:00:00:01"}\\n'); setInterval(() => {}, 1000);`,
    );
    const { VectisError } = await import("../../protocol/src/index.js");
    vi.mocked(readyGuest).mockRejectedValue(
      new VectisError(
        "rosetta_guest_unprepared",
        "Missing Rosetta.",
        "Prepare the Linux environment again",
      ),
    );
    await expect(
      runtime.start("unprepared", { ...environment, x64: "rosetta" }, () => {}),
    ).rejects.toMatchObject({
      code: "rosetta_guest_unprepared",
      nextStep: "Prepare the Linux environment again",
    });
    expect(await runtime.hasWorkDirectory("unprepared")).toBe(false);
  },
);
