import type { ChildProcess } from "node:child_process";
import { VectisError } from "../../protocol/src/index.js";

export function waitForAppleVm(
  child: ChildProcess,
  timeoutMs = 30000,
): Promise<{ macAddress?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.off("exit", exit);
      child.off("error", error);
    };
    const fail = (message: string) => {
      cleanup();
      reject(
        new VectisError(
          "vm_start_failed",
          message,
          "Inspect the prepared image and Apple helper configuration.",
        ),
      );
    };
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65536) return fail("The Apple helper exceeded the startup output limit.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return fail("The Apple helper returned invalid startup output.");
        }
        if (typeof event !== "object" || event === null || !("event" in event))
          return fail("The Apple helper returned an invalid event.");
        if (event.event === "vm.running") {
          if (
            "macAddress" in event &&
            (typeof event.macAddress !== "string" ||
              !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(event.macAddress))
          )
            return fail("The Apple helper returned an invalid network address.");
          cleanup();
          resolve(
            "macAddress" in event && typeof event.macAddress === "string"
              ? { macAddress: event.macAddress }
              : {},
          );
          return;
        }
        if (event.event === "vm.error" || event.event === "vm.stopped")
          return fail("The virtual machine stopped before startup completed.");
      }
    };
    const exit = () => fail("The Apple helper exited before virtual machine startup completed.");
    const error = () => fail("The Apple helper could not be started.");
    const timer = setTimeout(
      () => fail("The Apple helper did not confirm virtual machine startup in time."),
      timeoutMs,
    );
    child.stdout?.on("data", data);
    child.once("exit", exit);
    child.once("error", error);
    if (!child.stdout || child.exitCode !== null || child.signalCode !== null) exit();
  });
}
