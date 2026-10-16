import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Instance } from "../../../packages/protocol/src/index.js";

type Pressure = "normal" | "warning" | "critical";
export type ResourceUsage = {
  footprintsMiB: ReadonlyMap<string, number>;
  pressure: Pressure;
  pressureKnown: boolean;
};
export type ResourceProbe = (instances: readonly Instance[]) => ResourceUsage;

const execute = promisify(execFile);
async function readResource(file: string, args: string[]): Promise<string> {
  const { stdout } = await execute(file, args, { timeout: 1000, maxBuffer: 1024 });
  return stdout;
}

type Measurement = { value?: string; expiresAt: number; pending: boolean };

export function createResourceProbe(read = readResource, now = Date.now): ResourceProbe {
  const footprints = new Map<string, Measurement>();
  const pressure: Measurement = { expiresAt: 0, pending: false };
  function cached(entry: Measurement, file: string, args: string[]) {
    if (!entry.pending && now() >= entry.expiresAt) {
      entry.pending = true;
      void read(file, args)
        .then((value) => {
          entry.value = value.trim();
        })
        .catch(() => {
          delete entry.value;
        })
        .finally(() => {
          entry.expiresAt = now() + 5000;
          entry.pending = false;
        });
    }
    return entry.value;
  }
  return (instances) => {
    const live = instances.filter(
      (instance) =>
        instance.status !== "stopped" && Number.isSafeInteger(instance.pid) && instance.pid > 0,
    );
    const keys = new Set(live.map((instance) => `${instance.id}:${instance.pid}`));
    for (const key of footprints.keys()) if (!keys.has(key)) footprints.delete(key);
    const footprintsMiB = new Map<string, number>();
    for (const instance of live) {
      const key = `${instance.id}:${instance.pid}`;
      let entry = footprints.get(key);
      if (!entry) {
        entry = { expiresAt: 0, pending: false };
        footprints.set(key, entry);
      }
      const value = cached(entry, "/bin/ps", ["-o", "rss=", "-p", String(instance.pid)]);
      const rss = value && /^\d+$/.test(value) ? Number(value) : undefined;
      if (rss !== undefined && Number.isSafeInteger(rss))
        footprintsMiB.set(instance.id, rss / 1024);
    }
    const value = cached(pressure, "/usr/sbin/sysctl", [
      "-n",
      "kern.memorystatus_vm_pressure_level",
    ]);
    return {
      footprintsMiB,
      pressure: value === "2" ? "warning" : value === "4" ? "critical" : "normal",
      pressureKnown: value === "1" || value === "2" || value === "4",
    };
  };
}

export const resourceProbe = createResourceProbe();
