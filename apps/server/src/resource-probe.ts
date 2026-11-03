import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appleVmProcessPid } from "../../../packages/runner/src/apple.js";
import type { Environment, Instance } from "../../../packages/protocol/src/index.js";

type Pressure = "normal" | "warning" | "critical";
export type ResourceUsage = {
  footprintsMiB: ReadonlyMap<string, number>;
  pressure: Pressure;
  pressureKnown: boolean;
};
export type ResourceProbe = (
  instances: readonly Instance[],
  environments?: readonly Environment[],
) => ResourceUsage;

const execute = promisify(execFile);
async function readResource(file: string, args: string[]): Promise<string> {
  const { stdout } = await execute(file, args, { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

type Measurement = { value?: string; expiresAt: number; pending: boolean };

export function createResourceProbe(
  read = readResource,
  now = Date.now,
  vmProcessPid = appleVmProcessPid,
): ResourceProbe {
  const processes: Measurement = { expiresAt: 0, pending: false };
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
  return (instances, environments = []) => {
    const live = instances.filter(
      (instance) =>
        instance.status !== "stopped" && Number.isSafeInteger(instance.pid) && instance.pid > 0,
    );
    const table = live.length
      ? cached(processes, "/bin/ps", ["-A", "-o", "pid=,ppid=,rss="])
      : undefined;
    const rows = new Map<number, { parent: number; rss: number }>();
    if (table) {
      for (const line of table.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) {
          rows.clear();
          break;
        }
        const pid = Number(match[1]);
        const parent = Number(match[2]);
        const rss = Number(match[3]);
        if (![pid, parent, rss].every(Number.isSafeInteger)) {
          rows.clear();
          break;
        }
        rows.set(pid, { parent, rss });
      }
    }
    const children = new Map<number, number[]>();
    for (const [pid, row] of rows) {
      const siblings = children.get(row.parent) ?? [];
      siblings.push(pid);
      children.set(row.parent, siblings);
    }
    const footprintsMiB = new Map<string, number>();
    for (const instance of live) {
      if (!rows.has(instance.pid)) continue;
      const os = environments.find((environment) => environment.id === instance.environmentId)?.os;
      const pids = [instance.pid];
      if (os === "linux" || os === "macos") {
        const vmPid = vmProcessPid(instance.pid);
        if (vmPid === undefined || vmPid === instance.pid || !rows.has(vmPid)) continue;
        pids.push(vmPid);
      } else if (os !== "windows") continue;
      const visited = new Set<number>();
      let rss = 0;
      while (pids.length) {
        const pid = pids.pop();
        if (pid === undefined || visited.has(pid)) continue;
        visited.add(pid);
        rss += rows.get(pid)?.rss ?? 0;
        if (os === "windows") pids.push(...(children.get(pid) ?? []));
      }
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
