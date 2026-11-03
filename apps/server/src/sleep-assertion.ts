import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export class SleepAssertion {
  private child: ChildProcess | undefined;
  private needed = false;
  private closed = false;

  constructor(
    private readonly spawnChild: (
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess = spawn,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly log: (message: string) => void = console.error,
  ) {}

  update(count: number) {
    const needed = count > 0;
    if (this.closed || needed === this.needed) return;
    this.needed = needed;
    if (!needed) {
      this.release();
      return;
    }
    if (this.platform !== "darwin") return;
    try {
      const child = this.spawnChild("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore",
      });
      this.child = child;
      child.once("spawn", () => {
        if (this.child === child) this.log("Idle sleep assertion started.");
      });
      let reported = false;
      const failed = () => {
        if (this.child !== child) return;
        this.child = undefined;
        if (!reported && this.needed) {
          reported = true;
          this.log("Idle sleep assertion unavailable: caffeinate failed or exited unexpectedly.");
        }
      };
      child.once("error", failed);
      child.once("exit", failed);
    } catch {
      this.log("Idle sleep assertion unavailable: could not start caffeinate.");
    }
  }

  close() {
    this.closed = true;
    this.release();
  }

  private release() {
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.kill();
      this.log("Idle sleep assertion release requested.");
    }
  }
}
