import { expect, test, vi } from "vitest";
import type { Instance } from "../../../packages/protocol/src/index.js";
import { createResourceProbe } from "./resource-probe.js";

const instance: Instance = {
  id: "owned",
  environmentId: "linux",
  status: "running",
  pid: 123,
  createdAt: "",
};

test("probes share in-flight work and cache results for five seconds", async () => {
  let time = 0;
  let rss = "3145728";
  let pressure = "1";
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? rss : pressure));
  const probe = createResourceProbe(read, () => time);
  expect(probe([instance])).toMatchObject({ pressure: "normal", pressureKnown: false });
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(true));
  expect(probe([instance]).footprintsMiB.get(instance.id)).toBe(3072);
  expect(read).toHaveBeenCalledWith("/bin/ps", ["-o", "rss=", "-p", "123"]);
  expect(read).toHaveBeenCalledWith("/usr/sbin/sysctl", [
    "-n",
    "kern.memorystatus_vm_pressure_level",
  ]);
  time = 4999;
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(2);
  time = 5000;
  rss = "4194304";
  pressure = "2";
  probe([instance]);
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(4);
  await vi.waitFor(() => expect(probe([instance]).pressure).toBe("warning"));
  expect(probe([instance]).footprintsMiB.get(instance.id)).toBe(4096);
});

test("PID changes and stopped instances discard cached footprints", async () => {
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? "1048576" : "4"));
  const probe = createResourceProbe(read);
  probe([instance, { ...instance, id: "stopped", status: "stopped", pid: 999 }]);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(true));
  expect(probe([instance]).pressure).toBe("critical");
  const changed = { ...instance, pid: 456 };
  expect(probe([changed]).footprintsMiB.size).toBe(0);
  await vi.waitFor(() => expect(probe([changed]).footprintsMiB.get(instance.id)).toBe(1024));
  expect(read).toHaveBeenCalledTimes(3);
  expect(probe([{ ...changed, status: "stopped" }]).footprintsMiB.size).toBe(0);
  expect(probe([changed]).footprintsMiB.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(4);
});

test.each(["", "garbage", "-10", "1.5", "Infinity"])(
  "invalid probe output %j remains unknown",
  async (output) => {
    const read = vi.fn(async () => output);
    const probe = createResourceProbe(read);
    probe([instance, { ...instance, id: "new", pid: 0, status: "starting" }]);
    await vi.waitFor(() => expect(read).toHaveResolvedTimes(2));
    expect(probe([instance])).toEqual({
      footprintsMiB: new Map(),
      pressure: "normal",
      pressureKnown: false,
    });
    expect(read).toHaveBeenCalledTimes(2);
  },
);

test("failed probes are cached and replace stale data with unknown", async () => {
  let time = 0;
  const read = vi.fn(async (file: string) => (file === "/bin/ps" ? "1048576" : "2"));
  const probe = createResourceProbe(read, () => time);
  probe([instance]);
  await vi.waitFor(() => expect(probe([instance]).pressure).toBe("warning"));
  time = 5000;
  read.mockRejectedValue(new Error("Probe timed out"));
  probe([instance]);
  await vi.waitFor(() => expect(probe([instance]).pressureKnown).toBe(false));
  expect(probe([instance]).footprintsMiB.size).toBe(0);
  expect(read).toHaveBeenCalledTimes(4);
  time = 9999;
  probe([instance]);
  expect(read).toHaveBeenCalledTimes(4);
});
