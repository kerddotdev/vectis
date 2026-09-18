import { freemem, totalmem } from "node:os";
import { runProcess } from "./process.js";

export function parseAvailableMemory(statistics: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(statistics)?.[1];
  const counts = ["free", "inactive", "speculative"].map(
    (name) => new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m").exec(statistics)?.[1],
  );
  if (!size || counts.some((value) => value === undefined)) return undefined;
  const available = Number(size) * counts.reduce((sum, value) => sum + Number(value), 0);
  return Number.isSafeInteger(available) && available >= 0 ? available : undefined;
}

export async function availableHostMemory(): Promise<number> {
  if (process.platform !== "darwin") return freemem();
  try {
    const statistics = await runProcess("/usr/bin/vm_stat", [], AbortSignal.timeout(2000));
    return Math.min(parseAvailableMemory(statistics) ?? freemem(), totalmem());
  } catch {
    return freemem();
  }
}
