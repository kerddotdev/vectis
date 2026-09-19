import { Schema } from "effect";

export const UpdateState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("idle"), checkedAt: Schema.optional(Schema.Number) }),
  Schema.Struct({ status: Schema.Literal("checking") }),
  Schema.Struct({
    status: Schema.Literal("downloading"),
    version: Schema.String,
    percent: Schema.Number,
  }),
  Schema.Struct({ status: Schema.Literal("ready"), version: Schema.String }),
  Schema.Struct({ status: Schema.Literal("waiting"), version: Schema.String }),
  Schema.Struct({ status: Schema.Literal("installing"), version: Schema.String }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type UpdateState = typeof UpdateState.Type;

export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "none" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; error: unknown };

export interface Updater {
  check(): Promise<void>;
  quitAndInstall(): void;
  subscribe(listener: (event: UpdaterEvent) => void): void;
}

export interface UpdateService {
  // Stops the local service only when no VMs or operations are active; never interrupts work.
  stopIfIdle(): Promise<"stopped" | "not-running" | "busy">;
  // Records that the service was running so the updated app starts it again.
  rememberRestart(): Promise<void>;
}

export class UpdateController {
  private state: UpdateState = { status: "idle" };
  private timers = new Map<"check" | "install", ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly updater: Updater,
    private readonly service: UpdateService,
    private readonly options: { checkIntervalMs: number; retryIdleMs: number },
  ) {
    updater.subscribe((event) => this.receive(event));
  }

  private receive(event: UpdaterEvent) {
    const settled = this.state.status === "waiting" || this.state.status === "installing";
    switch (event.type) {
      case "checking":
        if (!settled) this.set({ status: "checking" });
        break;
      case "available":
        if (!settled) this.set({ status: "downloading", version: event.version, percent: 0 });
        break;
      case "none":
        if (!settled) this.set({ status: "idle", checkedAt: Date.now() });
        break;
      case "progress":
        if (this.state.status === "downloading")
          this.set({ ...this.state, percent: Math.max(0, Math.min(100, event.percent)) });
        break;
      case "downloaded":
        if (!settled) this.set({ status: "ready", version: event.version });
        break;
      case "error":
        if (!settled)
          this.set({
            status: "error",
            message:
              event.error instanceof Error ? event.error.message : "The update check failed.",
          });
    }
  }

  current() {
    return this.state;
  }

  start(firstCheckMs: number) {
    this.schedule("check", () => void this.check(), firstCheckMs);
  }

  async check() {
    if (["ready", "waiting", "installing"].includes(this.state.status)) return this.state;
    this.schedule("check", () => void this.check(), this.options.checkIntervalMs);
    if (this.state.status === "downloading" || this.state.status === "checking") return this.state;
    try {
      await this.updater.check();
    } catch (error) {
      this.set({
        status: "error",
        message: error instanceof Error ? error.message : "The update check failed.",
      });
    }
    return this.state;
  }

  async install() {
    if (this.state.status !== "ready" && this.state.status !== "waiting") return this.state;
    const version = this.state.version;
    const service = await this.service.stopIfIdle();
    if (service === "busy") {
      this.set({ status: "waiting", version });
      this.schedule("install", () => void this.install(), this.options.retryIdleMs);
      return this.state;
    }
    this.set({ status: "installing", version });
    if (service === "stopped") await this.service.rememberRestart();
    this.close();
    this.updater.quitAndInstall();
    return this.state;
  }

  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private set(state: UpdateState) {
    this.state = state;
  }

  private schedule(name: "check" | "install", run: () => void, delay: number) {
    if (this.closed) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        run();
      }, delay),
    );
  }
}
