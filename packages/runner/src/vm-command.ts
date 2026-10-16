import type { ChildProcess } from "node:child_process";

export function requestVmCommand(
  child: ChildProcess,
  command: string,
  response: (message: object) => boolean | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (accepted: boolean) => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.stdin?.off("error", unavailable);
      child.off("close", closed);
      child.off("error", unavailable);
      resolve(accepted);
    };
    const unavailable = () => finish(false);
    const closed = () => finish(child.exitCode === 0 && child.signalCode === null);
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65536) return unavailable();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return unavailable();
        }
        if (!message || typeof message !== "object") return unavailable();
        const accepted = response(message);
        if (accepted !== undefined) return finish(accepted);
      }
    };
    const timer = setTimeout(unavailable, timeoutMs);
    child.stdout?.on("data", data);
    child.stdin?.once("error", unavailable);
    child.once("close", closed);
    child.once("error", unavailable);
    if (child.exitCode !== null || child.signalCode !== null) return closed();
    if (!child.stdout || !child.stdin?.writable) return unavailable();
    child.stdin.write(command, (error) => {
      if (error) unavailable();
    });
  });
}
