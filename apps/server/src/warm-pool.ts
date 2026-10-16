import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type {
  Environment,
  Instance,
  Operation,
  RunnerCapacity,
  Snapshot,
  VectisError,
} from "../../../packages/protocol/src/index.js";
import { RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { readyGuest } from "../../../packages/runner/src/guest-ready.js";
import type { GuestConnection } from "../../../packages/runner/src/guest.js";
import { Store } from "./store.js";
import { preparationBusy } from "./runner-capacity.js";

const maxAgeMs = 30 * 60 * 1000;

interface Controls {
  start(environment: Environment, key: string, signal: AbortSignal): Promise<Instance>;
  stop(instance: Instance): Promise<void>;
  admission(snapshot: Snapshot, environment: Environment, count?: number): VectisError | undefined;
  capacity(snapshot: Snapshot): RunnerCapacity;
  now?: () => number;
  onError(error: unknown): void;
}

export class WarmPool {
  private ready = new Map<string, { connection: GuestConnection; configuration: string }>();
  private stopping = new Map<string, Promise<void>>();
  private pending: { environment: Environment; abort: AbortController } | undefined;
  private sweep: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  private retryAt = 0;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly controls: Controls,
  ) {
    this.now = controls.now ?? Date.now;
  }

  start() {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.store.onChange(() => this.refresh());
    this.refresh();
  }

  private waiting(snapshot: Snapshot) {
    return snapshot.operations.some((operation) => {
      if (operation.command !== "runner.run" || !["accepted", "running"].includes(operation.status))
        return false;
      const progress = Schema.is(RunnerProgress)(operation.result) ? operation.result : undefined;
      const start = snapshot.operations.find((item) => item.key === `${operation.id}:start`);
      return !snapshot.instances.some(
        (instance) =>
          instance.id === (progress?.instanceId ?? start?.id) && instance.status !== "stopped",
      );
    });
  }

  private enabled(snapshot: Snapshot, environment: Environment) {
    return (
      !this.closed &&
      !snapshot.machine.paused &&
      !preparationBusy(snapshot) &&
      (environment.warmPool ?? 0) > 0 &&
      environment.state === "ready"
    );
  }

  canFill(environment: Environment) {
    const snapshot = this.store.snapshot();
    const physical = {
      ...snapshot,
      instances: snapshot.instances.map((instance) => ({ ...instance, role: undefined })),
    };
    const capacity = this.controls.capacity(physical);
    const pooled = snapshot.instances.filter(
      (instance) => instance.role && ["starting", "running"].includes(instance.status),
    );
    return (
      this.enabled(snapshot, environment) &&
      !this.waiting(snapshot) &&
      capacity.active + pooled.length + 1 < capacity.max &&
      pooled.filter((instance) => instance.environmentId === environment.id).length <
        (environment.warmPool ?? 0) &&
      (capacity.environments?.find((item) => item.environmentId === environment.id)?.available ??
        0) > 1 &&
      !this.controls.admission(snapshot, environment, 2)
    );
  }

  refresh() {
    if (this.closed) return;
    const snapshot = this.store.snapshot();
    if (snapshot.environments.some((environment) => (environment.warmPool ?? 0) > 0)) {
      if (!this.timer) {
        this.timer = setInterval(() => this.refresh(), 5000);
        this.timer.unref();
      }
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.pending) {
      const current = snapshot.environments.find(
        (item) => item.id === this.pending?.environment.id,
      );
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(this.pending.environment) ||
        !this.enabled(snapshot, current) ||
        this.waiting(snapshot)
      )
        this.pending.abort.abort();
    }
    this.dirty = true;
    if (this.sweep) return;
    // Defer work until the current store transaction or service command has finished.
    this.sweep = Promise.resolve()
      .then(() => this.replenish())
      .catch((error: unknown) => {
        this.retryAt = this.now() + 30000;
        this.controls.onError(error);
      })
      .finally(() => {
        this.sweep = undefined;
        if (this.dirty && !this.closed) this.refresh();
      });
  }

  private async replenish() {
    this.dirty = false;
    for (const [id, entry] of this.ready) {
      const snapshot = this.store.snapshot();
      const instance = snapshot.instances.find((item) => item.id === id);
      const environment = snapshot.environments.find((item) => item.id === instance?.environmentId);
      if (!instance || instance.status !== "running" || instance.role !== "warm") {
        this.ready.delete(id);
        continue;
      }
      const age = this.now() - Date.parse(instance.createdAt);
      const siblings = snapshot.instances.filter(
        (item) =>
          item.environmentId === instance.environmentId &&
          item.role === "warm" &&
          item.status === "running",
      );
      if (
        !environment ||
        !this.enabled(snapshot, environment) ||
        JSON.stringify(environment) !== entry.configuration ||
        siblings.length > (environment.warmPool ?? 0) ||
        !Number.isFinite(age) ||
        age < 0 ||
        age >= maxAgeMs
      )
        await this.stop(instance);
    }
    if (this.closed || this.now() < this.retryAt) return;
    const environment = this.store.snapshot().environments.find((item) => this.canFill(item));
    if (!environment) return;
    const abort = new AbortController();
    this.pending = { environment, abort };
    let instance: Instance | undefined;
    try {
      instance = await this.controls.start(
        environment,
        `warm:${environment.id}:${randomUUID()}`,
        abort.signal,
      );
      const connection = await readyGuest(environment, instance, abort.signal);
      abort.signal.throwIfAborted();
      const current = this.store.snapshot().instances.find((item) => item.id === instance?.id);
      if (!current || current.status !== "running")
        throw new Error("Warm VM stopped before readiness.");
      this.ready.set(current.id, { connection, configuration: JSON.stringify(environment) });
      this.store.put("instance", current.id, { ...current, role: "warm" });
    } catch (error) {
      if (instance) await this.stop(instance);
      if (!abort.signal.aborted) throw error;
    } finally {
      this.pending = undefined;
    }
    this.dirty = true;
  }

  claim(environmentId: string, operation: Operation) {
    if (this.closed || this.store.snapshot().machine.paused) return undefined;
    for (const [id, entry] of this.ready) {
      const snapshot = this.store.snapshot();
      const instance = snapshot.instances.find((item) => item.id === id);
      const environment = snapshot.environments.find((item) => item.id === environmentId);
      const age = instance ? this.now() - Date.parse(instance.createdAt) : NaN;
      if (
        !instance ||
        instance.environmentId !== environmentId ||
        instance.status !== "running" ||
        instance.role !== "warm" ||
        this.stopping.has(id) ||
        !environment ||
        !(environment.warmPool ?? 0) ||
        JSON.stringify(environment) !== entry.configuration ||
        !Number.isFinite(age) ||
        age < 0 ||
        age >= maxAgeMs
      )
        continue;
      const current = snapshot.operations.find((item) => item.id === operation.id);
      const progress = Schema.decodeUnknownSync(RunnerProgress)(current?.result);
      const claimed = { ...instance, role: undefined };
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.put("instance", id, claimed);
        this.store.update(operation, { result: { ...progress, instanceId: id } });
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
      this.ready.delete(id);
      return { instance: claimed, connection: entry.connection };
    }
    return undefined;
  }

  async yieldForJob(environment: Environment) {
    this.pending?.abort.abort();
    await this.sweep;
    for (const instance of this.store.snapshot().instances) {
      if (!this.controls.admission(this.store.snapshot(), environment)) break;
      if (
        instance.environmentId !== environment.id &&
        (this.ready.has(instance.id) || this.stopping.has(instance.id))
      )
        await this.stop(instance);
    }
  }

  async drainEnvironment(environmentId?: string) {
    if (!environmentId || this.pending?.environment.id === environmentId)
      this.pending?.abort.abort();
    for (const instance of this.store.snapshot().instances)
      if (
        (!environmentId || instance.environmentId === environmentId) &&
        (this.ready.has(instance.id) || this.stopping.has(instance.id))
      )
        await this.stop(instance);
  }

  private stop(instance: Instance): Promise<void> {
    const pending = this.stopping.get(instance.id);
    if (pending) return pending;
    this.ready.delete(instance.id);
    const done = this.controls
      .stop(instance)
      .catch((error: unknown) => {
        const current = this.store.snapshot().instances.find((item) => item.id === instance.id);
        if (current && current.status !== "stopped")
          this.store.put("instance", current.id, { ...current, role: undefined });
        throw error;
      })
      .finally(() => this.stopping.delete(instance.id));
    this.stopping.set(instance.id, done);
    return done;
  }

  async close() {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.pending?.abort.abort();
    await this.sweep;
    await this.drainEnvironment();
    await Promise.all(this.stopping.values());
  }
}
