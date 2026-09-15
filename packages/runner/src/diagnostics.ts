import { arch, cpus, platform, totalmem } from "node:os";
import type { Diagnostics } from "../../protocol/src/diagnostics.js";
import type { RuntimeOptions } from "./runtime.js";
export function runtimeDiagnostics(
  options: RuntimeOptions & { keychainHelper?: string },
  source: Diagnostics["source"],
): Diagnostics {
  return {
    source,
    host: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      memoryMiB: Math.floor(totalmem() / 1048576),
    },
    supportedHost: platform() === "darwin" && arch() === "arm64",
    configured: {
      appleHelper: Boolean(options.appleHelper),
      qemu: Boolean(options.qemu),
      qemuImg: Boolean(options.qemuImg),
      swtpm: Boolean(options.swtpm),
      keychainHelper: Boolean(options.keychainHelper),
    },
    home: options.home,
  };
}
