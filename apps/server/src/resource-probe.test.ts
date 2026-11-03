import { spawn } from "node:child_process";
import { once } from "node:events";
import { totalmem } from "node:os";
import { waitForAppleVm, appleVmProcessPid } from "../../../packages/runner/src/apple.js";
import { expect, test, vi } from "vitest";
import type { Environment, Instance } from "../../../packages/protocol/src/index.js";
import { createResourceProbe, parseCompressorRatio, parseSwapUsedRatio } from "./resource-probe.js";

const instance: Instance = {
  id: "owned",
  environmentId: "linux",
  status: "running",
  pid: 123,
  createdAt: "",
};

const windows: Environment = {
  id: "linux",
  name: "Windows",
  os: "windows",
  basePath: "/synthetic/base",
  cpu: 2,
  memoryMiB: 12288,
  state: "ready",
};
function createProbe(...args: Parameters<typeof createResourceProbe>) {
  const probe = createResourceProbe(...args);
  return (instances: readonly Instance[], environments = [windows]) =>
    probe(instances, environments);
}

test("probes share in-flight work and cache results for five seconds", async () => {
  let time = 0;
  let rss = "123 1 3145728";
  let pressure = "1";
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? rss : pressure));
  const probe = createProbe(read, () => time);
  expect(probe([instance])).toMatchObject({ pressure: "normal", pressureKnown: false });
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(true));
  expect(probe([instance]).footprintsMiB.get(instance.id)).toBe(3072);
  expect(read).toHaveBeenCalledWith("/bin/ps", ["-A", "-o", "pid=,ppid=,rss="]);
  expect(read).toHaveBeenCalledWith("/usr/sbin/sysctl", [
    "-n",
    "kern.memorystatus_vm_pressure_level",
    "vm.swapusage",
  ]);
  time = 4999;
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(3);
  time = 5000;
  rss = "123 1 4194304";
  pressure = "2";
  probe([instance]);
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(6);
  await vi.waitFor(() => expect(probe([instance]).pressure).toBe("warning"));
  expect(probe([instance]).footprintsMiB.get(instance.id)).toBe(4096);
});

test("primes compressor measurement and reports compressor and swap ratios", async () => {
  const read = vi.fn(async (file: string) => {
    if (file === "/usr/bin/vm_stat")
      return "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 1192728.";
    if (file === "/usr/sbin/sysctl")
      return "2\ntotal = 8192.00M  used = 7475.20M  free = 716.80M  (encrypted)";
    return "123 1 1024";
  });
  const probe = createProbe(read);
  expect(read).toHaveBeenCalledWith("/usr/bin/vm_stat", []);
  expect(probe([instance]).compressorRatio).toBeUndefined();
  await vi.waitFor(() => {
    const usage = probe([instance]);
    expect(usage.compressorRatio).toBeCloseTo((1192728 * 16384) / totalmem());
    expect(usage.swapUsedRatio).toBeCloseTo(7475.2 / 8192);
    expect(usage.pressure).toBe("warning");
  });
});

test("PID changes and stopped instances cannot reuse another process footprint", async () => {
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? "123 1 1048576" : "4"));
  const probe = createProbe(read);
  probe([instance]);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(true));
  expect(probe([instance]).pressure).toBe("critical");
  expect(probe([{ ...instance, pid: 456 }]).footprintsMiB.size).toBe(0);
  expect(probe([{ ...instance, status: "stopped" }]).footprintsMiB.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(3);
});

test.each(["", "garbage", "-10", "1.5", "Infinity"])(
  "invalid probe output %j remains unknown",
  async (output) => {
    const read = vi.fn(async () => output);
    const probe = createProbe(read);
    probe([instance, { ...instance, id: "new", pid: 0, status: "starting" }]);
    await vi.waitFor(() => expect(read).toHaveResolvedTimes(3));
    expect(probe([instance])).toEqual({
      footprintsMiB: new Map(),
      pressure: "normal",
      pressureKnown: false,
    });
    expect(read).toHaveBeenCalledTimes(3);
  },
);

test("failed probes are cached and replace stale data with unknown", async () => {
  let time = 0;
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? "123 1 1048576" : "2"));
  const probe = createProbe(read, () => time);
  probe([instance]);
  await vi.waitFor(() => expect(probe([instance]).pressure).toBe("warning"));
  time = 5000;
  read.mockRejectedValue(new Error("Probe timed out"));
  probe([instance]);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(false));
  expect(probe([instance]).footprintsMiB.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(6);
  time = 9999;
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(6);
});

test("one process snapshot includes supervisor, QEMU, swtpm and nested descendants for every VM", async () => {
  const read = vi.fn(async (file: string) =>
    file === "/bin/ps"
      ? "123 1 10240\n124 123 6291456\n125 123 20480\n126 124 1024\n200 1 10240\n201 200 2097152\n900 1 9999999"
      : "1",
  );
  const probe = createProbe(read);
  const instances = [instance, { ...instance, id: "second", pid: 200 }];
  probe(instances);
  await vi.waitFor(() => expect(probe(instances).pressureKnown).toBe(true));
  expect(probe(instances).footprintsMiB).toEqual(
    new Map([
      ["owned", 6175],
      ["second", 2058],
    ]),
  );
  expect(read.mock.calls.filter(([file]) => file === "/bin/ps")).toHaveLength(1);
});

test("Apple accounting adds the reported XPC process to the helper, without guessing by ancestry", async () => {
  const read = vi.fn(async (file: string) =>
    file === "/bin/ps" ? "123 1 21504\n500 1 3145728\n501 1 8388608" : "1",
  );
  const mapped = createProbe(read, Date.now, (pid) => (pid === 123 ? 500 : undefined));
  const linux = { ...windows, os: "linux" as const };
  mapped([instance], [linux]);
  await vi.waitFor(() => expect(mapped([instance], [linux]).pressureKnown).toBe(true));
  expect(mapped([instance], [linux]).footprintsMiB.get("owned")).toBe(3093);
  expect(mapped([instance], [{ ...linux, os: "macos" }]).footprintsMiB.get("owned")).toBe(3093);
  const missing = createProbe(read, Date.now, () => undefined);
  missing([instance], [linux]);
  await vi.waitFor(() => expect(missing([instance], [linux]).pressureKnown).toBe(true));
  expect(missing([instance], [linux]).footprintsMiB.size).toBe(0);
  expect(mapped([{ ...instance, pid: 501 }], [linux]).footprintsMiB.size).toBe(0);
});

test("vm.process events reach accounting and their mapping is released when the helper closes", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stdout.write('{"event":"vm.process","pid":500}\\n{"event":"vm.running"}\\n');
    process.stdin.resume();
  `,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const closed = once(child, "close");
  try {
    await expect(waitForAppleVm(child)).resolves.toEqual({ vmPid: 500 });
    const pid = child.pid;
    if (pid === undefined) throw new Error("Synthetic helper did not start");
    const probe = createProbe(async (file) =>
      file === "/bin/ps" ? `${pid} 1 21504\n500 1 3145728` : "1",
    );
    const owned = { ...instance, pid };
    const environments = [{ ...windows, os: "linux" as const }];
    probe([owned], environments);
    await vi.waitFor(() => expect(probe([owned], environments).pressureKnown).toBe(true));
    expect(probe([owned], environments).footprintsMiB.get("owned")).toBe(3093);
    child.stdin.end();
    await closed;
    expect(appleVmProcessPid(pid)).toBeUndefined();
    expect(probe([owned], environments).footprintsMiB.size).toBe(0);
  } finally {
    child.stdin.end();
    await closed;
  }
});

test("parses macOS swap and compressor measurements", () => {
  const stats = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 7000.
Pages occupied by compressor: 1192728.
Pages stored in compressor: 1753266.`;
  expect(parseCompressorRatio(stats, 48 * 1024 ** 3)).toBe((1192728 * 16384) / (48 * 1024 ** 3));
  expect(
    parseSwapUsedRatio("total = 8192.00M  used = 7475.20M  free = 716.80M  (encrypted)"),
  ).toBeCloseTo(7.3 / 8);
  expect(parseSwapUsedRatio("total = 0.00M  used = 0.00M  free = 0.00M")).toBeUndefined();
  expect(parseSwapUsedRatio("unavailable")).toBeUndefined();
  expect(parseCompressorRatio("unavailable", 1024)).toBeUndefined();
});
