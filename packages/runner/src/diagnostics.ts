import { accessSync, constants, statSync } from "node:fs";
import type { Environment } from "../../protocol/src/index.js";
import type { ReadinessCheck } from "../../protocol/src/readiness.js";
import { arch, cpus, platform, totalmem } from "node:os";
import type { Diagnostics } from "../../protocol/src/diagnostics.js";
import type { RuntimeOptions } from "./runtime.js";
export function runtimeDiagnostics(
  options: RuntimeOptions & { keychainHelper?: string },
  source: Diagnostics["source"],
  environments: ReadonlyArray<Pick<Environment, "os">> = [],
): Diagnostics & { checks: ReadinessCheck[] } {
  const supportedHost = platform() === "darwin" && arch() === "arm64";
  const windows = environments.some((environment) => environment.os === "windows");
  const checks: ReadinessCheck[] = [
    {
      id: "host",
      status: supportedHost ? "ok" : "blocked",
      message: supportedHost
        ? "This host is supported."
        : "This release requires an Apple Silicon Mac.",
      ...(supportedHost
        ? {}
        : {
            code: "host_unsupported",
            nextStep: "Run the service on an Apple Silicon Mac.",
            target: { area: "diagnostics" } as const,
          }),
    },
  ];
  for (const [component, variable, windowsOnly] of [
    ["appleHelper", "VECTIS_APPLE_HELPER", false],
    ["qemu", "VECTIS_QEMU", true],
    ["qemuImg", "VECTIS_QEMU_IMG", true],
    ["swtpm", "VECTIS_SWTPM", true],
    ["keychainHelper", "VECTIS_KEYCHAIN_HELPER", false],
  ] as const) {
    const path = options[component];
    let executable = false;
    try {
      if (path && statSync(path).isFile()) {
        accessSync(path, constants.X_OK);
        executable = true;
      }
    } catch {}
    checks.push({
      id: `runtime.${component}`,
      status: executable ? "ok" : windowsOnly && !windows ? "attention" : "blocked",
      message: executable
        ? `${component} is configured and executable.`
        : `${component} is not configured with an existing executable file.${windowsOnly && !windows ? " It is needed only for Windows environments." : ""}`,
      ...(executable
        ? {}
        : {
            code: "runtime_component_missing",
            nextStep: `Set ${variable} to an executable file and restart the service.`,
            target: { area: "diagnostics", section: "runtime" } as const,
          }),
    });
  }
  let writable = false;
  try {
    if (statSync(options.home).isDirectory()) {
      accessSync(options.home, constants.W_OK | constants.X_OK);
      writable = true;
    }
  } catch {}
  checks.push({
    id: "home",
    status: writable ? "ok" : "blocked",
    message: writable
      ? "The service data home is writable."
      : "The service data home is missing or not writable.",
    ...(writable
      ? {}
      : {
          code: "home_not_writable",
          nextStep:
            "Create the selected service home and grant the service user write and directory access.",
          target: { area: "diagnostics", section: "home" } as const,
        }),
  });
  return {
    source,
    host: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      memoryMiB: Math.floor(totalmem() / 1048576),
    },
    supportedHost,
    checks,
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
