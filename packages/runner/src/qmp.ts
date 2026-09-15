import type { ChildProcess } from "node:child_process";
import { VectisError } from "../../protocol/src/index.js";

export function qemuSshPort(report: string): number {
  if (report.length > 65536)
    throw new VectisError(
      "guest_network_unavailable",
      "QEMU network report exceeds the size limit.",
    );
  const ports = [
    ...report.matchAll(
      /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+127\.0\.0\.1\s+(\d+)\s+10\.0\.2\.15\s+22\s+\d+\s+\d+\s*$/gm,
    ),
  ].map((match) => Number(match[1]));
  const [port] = ports;
  if (
    ports.length !== 1 ||
    port === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new VectisError(
      "guest_network_unavailable",
      "QEMU did not report a unique loopback SSH forward.",
    );
  return port;
}

export function waitForQemu(child: ChildProcess, timeoutMs = 30000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let diagnostic = "";
    let phase = "greeting";
    const stderr = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.stderr?.off("data", stderr);
      child.off("close", exit);
      child.off("error", exit);
    };
    const fail = () => {
      cleanup();
      if (diagnostic.includes("HV_BAD_ARGUMENT") && diagnostic.includes("tpm-tis-device")) {
        reject(
          new VectisError(
            "runtime_incompatible",
            "Apple hardware acceleration rejected the QEMU TPM memory mapping.",
            "Build the documented runtime in native/qemu and configure VECTIS_QEMU. Vectis does not fall back to emulation.",
          ),
        );
        return;
      }
      reject(
        new VectisError(
          "vm_start_failed",
          "QEMU did not confirm a running VM.",
          "Check hardware acceleration, firmware, TPM and image configuration.",
        ),
      );
    };
    const send = (execute: string, id: string, args?: Record<string, string>) =>
      child.stdin?.write(
        JSON.stringify({ execute, id, ...(args ? { arguments: args } : {}) }) + "\n",
      );
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65536) return fail();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return fail();
        }
        if (!message || typeof message !== "object") return fail();
        if ("error" in message) return fail();
        if (phase === "greeting" && "QMP" in message) {
          phase = "capabilities";
          send("qmp_capabilities", "capabilities");
        } else if (
          phase === "capabilities" &&
          "id" in message &&
          message.id === "capabilities" &&
          "return" in message
        ) {
          phase = "status";
          send("query-status", "status");
        } else if (
          phase === "status" &&
          "id" in message &&
          message.id === "status" &&
          "return" in message
        ) {
          const status = message.return;
          if (
            !status ||
            typeof status !== "object" ||
            !("running" in status) ||
            status.running !== true
          )
            return fail();
          phase = "network";
          send("human-monitor-command", "network", { "command-line": "info usernet" });
        } else if (
          phase === "network" &&
          "id" in message &&
          message.id === "network" &&
          "return" in message
        ) {
          if (typeof message.return !== "string") return fail();
          try {
            const port = qemuSshPort(message.return);
            cleanup();
            resolve(port);
          } catch (error) {
            cleanup();
            reject(error);
          }
          return;
        }
      }
    };
    const exit = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    child.stdout?.on("data", data);
    child.stderr?.on("data", stderr);
    child.once("close", exit);
    child.once("error", exit);
    if (!child.stdout || !child.stdin || child.exitCode !== null || child.signalCode !== null)
      fail();
  });
}
