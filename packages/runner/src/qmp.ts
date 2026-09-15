import type { ChildProcess } from "node:child_process";
import { VectisError } from "../../protocol/src/index.js";

export function waitForQemu(child: ChildProcess, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let phase = "greeting";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.off("exit", exit);
      child.off("error", exit);
    };
    const fail = () => {
      cleanup();
      reject(
        new VectisError(
          "vm_start_failed",
          "QEMU did not confirm a running VM.",
          "Check hardware acceleration, firmware, TPM and image configuration.",
        ),
      );
    };
    const send = (execute: string, id: string) =>
      child.stdin?.write(JSON.stringify({ execute, id }) + "\n");
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
          cleanup();
          resolve();
          return;
        }
      }
    };
    const exit = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    child.stdout?.on("data", data);
    child.once("exit", exit);
    child.once("error", exit);
    if (!child.stdout || !child.stdin || child.exitCode !== null || child.signalCode !== null)
      fail();
  });
}
