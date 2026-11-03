import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VectisError } from "../../protocol/src/index.js";

export function bootAutomaticMac(
  helper: string,
  bundle: string,
  directory: string,
  id: string,
  cpu: number,
  memoryMiB: number,
  password: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const receipt = join(directory, "exit-receipt.json");
  const child = spawn(
    helper,
    ["run", "macos", bundle, String(cpu), String(memoryMiB), "unused", "--provision"],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, VECTIS_EXIT_RECEIPT: receipt, VECTIS_INSTANCE_ID: id },
    },
  );
  let closed = false;
  let clean = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed) return;
    child.stdin.end();
    force ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
  };
  child.stdin.on("error", () => {});
  let rejectRunning: (error: Error) => void = () => {};
  const running = new Promise<string>((resolve, reject) => {
    rejectRunning = reject;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending = (pending + chunk).slice(-16384);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const raw: unknown = JSON.parse(line);
          if (Schema.is(Schema.Struct({ event: Schema.Literal("vm.stopped") }))(raw)) clean = true;
          const event = Schema.decodeUnknownSync(
            Schema.Struct({
              event: Schema.Literal("vm.running"),
              macAddress: Schema.String.check(
                Schema.isPattern(/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/),
              ),
            }),
          )(raw);
          resolve(event.macAddress);
        } catch {
          /* Ignore other bounded helper events, never retain credentials. */
        }
      }
    });
  });
  child.once("error", () =>
    rejectRunning(new VectisError("macos_boot_failed", "Automatic setup guest could not start.")),
  );
  const ownership = child.pid
    ? writeFile(receipt, JSON.stringify({ instanceId: id, pid: child.pid }), { mode: 0o600 })
    : Promise.resolve();
  void ownership.catch(stop);
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve())).then(
    async () => {
      closed = true;
      signal.removeEventListener("abort", stop);
      clearTimeout(force);
      child.stdin.destroy();
      rejectRunning(
        new VectisError("macos_boot_stopped", "Automatic setup guest stopped before readiness."),
      );
      await ownership.catch(() => {});
      if (child.pid)
        await writeFile(receipt, JSON.stringify({ instanceId: id, pid: child.pid }), {
          mode: 0o600,
        });
      return clean && child.exitCode === 0;
    },
  );
  void stopped.catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  child.stdin.write(JSON.stringify({ password }) + "\n");
  return {
    running: running.then(async (address) => {
      await ownership;
      return address;
    }),
    stopped,
    stop,
  };
}
