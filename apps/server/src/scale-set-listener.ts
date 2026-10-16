import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  VectisError,
  type Command,
  type Operation,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";
import type { MachineRepositories } from "../../../packages/protocol/src/repositories.js";
import type {
  ScaleSetBroker,
  ScaleSetGrant,
  ScaleSetState,
} from "../../../packages/protocol/src/scale-sets.js";
import {
  ScaleSetSessionClient,
  ScaleSetHttpError,
  ScaleSetProtocolError,
  type Message,
} from "../../../packages/scaleset/src/index.js";
import { restrictiveAccess } from "../../../packages/github/src/access-policy.js";
import type { Store } from "./store.js";

interface SessionClient {
  getMessage(
    lastMessageId: number,
    maxCapacity: number,
    signal: AbortSignal,
  ): Promise<Message | null>;
  acknowledgeMessage(messageId: number, signal: AbortSignal): Promise<unknown>;
  acquireJobs(
    ids: readonly number[],
    signal: AbortSignal,
    acquireJobUrl?: string,
  ): Promise<readonly number[]>;
}

const Pending = Schema.Struct({
  messageId: Schema.Int,
  assignedJobs: Schema.Int,
  keys: Schema.Array(Schema.String),
});
const Cursor = Schema.Struct({
  generation: Schema.Int,
  sequence: Schema.Int,
  lastMessageId: Schema.Int,
  assignedJobs: Schema.Int,
  pending: Schema.optional(Pending),
});
type Cursor = typeof Cursor.Type;
const Reservation = Schema.Struct({ bindingId: Schema.String, key: Schema.String });

function sessionClient(grant: ScaleSetGrant): SessionClient {
  const session = {
    sessionId: grant.sessionId,
    messageQueueUrl: grant.messageQueueUrl,
    messageQueueAccessToken: grant.messageQueueAccessToken,
    statistics: { totalAssignedJobs: grant.statistics?.totalAssignedJobs ?? 0 },
  };
  const client = new ScaleSetSessionClient(
    new URL(grant.messageQueueUrl).origin,
    grant.scaleSetId,
    session,
    fetch,
  );
  return {
    getMessage: (last, capacity, signal) => client.getMessage(last, capacity, signal),
    acknowledgeMessage: (id, signal) => client.acknowledgeMessage(id, signal),
    acquireJobs: (ids, signal, acquireJobUrl) => {
      let url: URL | undefined;
      try {
        url = acquireJobUrl === undefined ? undefined : new URL(acquireJobUrl);
      } catch {
        throw new VectisError(
          "scale_set_acquire_url_missing",
          "GitHub did not supply a valid scale set acquisition endpoint.",
        );
      }
      const suffix = `/_apis/runtime/runnerscalesets/${grant.scaleSetId}/acquirejobs`;
      if (
        !url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !url.pathname.toLowerCase().endsWith(suffix)
      )
        throw new VectisError(
          "scale_set_acquire_url_missing",
          "GitHub did not supply a supported scale set acquisition endpoint.",
        );
      url.pathname = url.pathname.slice(0, -suffix.length);
      url.search = "";
      return new ScaleSetSessionClient(url.href, grant.scaleSetId, session, fetch).acquireJobs(
        ids,
        signal,
      );
    },
  };
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function retryAfter(error: unknown) {
  if (!(error instanceof ScaleSetHttpError) || error.retryAfter === null) return 0;
  const seconds = Number(error.retryAfter);
  return (
    Math.max(
      0,
      Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now(),
    ) || 0
  );
}

function actionCode(error: unknown) {
  if (error instanceof ScaleSetProtocolError) return "scale_set_protocol_invalid";
  if (error instanceof ScaleSetHttpError) {
    if (error.status === 409) return "scale_set_session_conflict";
    if (error.status === 401 || error.status === 403) return "scale_set_auth_failed";
    if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
      return "scale_set_request_refused";
  }
  if (
    error instanceof VectisError &&
    ![
      "cloud_unavailable",
      "cloud_unconfigured",
      "github_unavailable",
      "github_rate_limited",
      "scale_set_unavailable",
      "scale_set_pending",
      "scale_set_cleanup_pending",
    ].includes(error.code)
  )
    return error.code;
}

type ListenerTask = {
  finished: boolean;
  bindingRevision: string;
  abort: AbortController;
  done: Promise<void>;
  state: ScaleSetState;
};

export class ScaleSetListener {
  private readonly tasks = new Map<string, ListenerTask>();
  private readonly stopped = new Map<string, ScaleSetState>();
  private unsubscribe?: () => void;
  private scheduled = false;
  private closing = false;
  private suspended = false;
  constructor(
    private readonly options: {
      store: Store;
      snapshot(): Snapshot;
      repositories(): MachineRepositories | undefined;
      connected(): boolean;
      broker(): ScaleSetBroker;
      submit(key: string, command: Command): Operation;
      sessionClient?: (grant: ScaleSetGrant) => SessionClient;
      random?: () => number;
    },
  ) {}

  start() {
    if (this.unsubscribe || this.closing) return;
    this.unsubscribe = this.options.store.onChange(() => this.schedule());
    this.reconcile();
  }
  states(): ScaleSetState[] {
    return [
      ...this.stopped.values(),
      ...[...this.tasks.values()].map((task) => ({
        ...task.state,
        state: task.abort.signal.aborted ? ("stopped" as const) : task.state.state,
      })),
    ].map((state) => ({ ...state, reservedRunners: this.reservations(state.bindingId, false) }));
  }
  private schedule() {
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closing) this.reconcile();
    });
  }
  private reconcile() {
    const bindings = this.options.repositories() ?? [];
    const snapshot = this.options.snapshot();
    const enabled = new Set(
      bindings
        .filter(
          (binding) =>
            binding.capacityMode === "scale_set" &&
            binding.automatic &&
            !this.suspended &&
            !snapshot.machine.paused &&
            this.options.connected(),
        )
        .map((binding) => binding.id),
    );
    for (const [id, task] of this.tasks) {
      const binding = bindings.find((binding) => binding.id === id);
      if (!enabled.has(id) || task.bindingRevision !== JSON.stringify(binding)) task.abort.abort();
      if (task.abort.signal.aborted && task.finished) this.tasks.delete(id);
    }
    for (const id of this.stopped.keys())
      if (!bindings.some((binding) => binding.id === id)) this.stopped.delete(id);
    for (const binding of bindings) {
      if (!enabled.has(binding.id)) {
        if (binding.capacityMode === "scale_set" && !this.tasks.has(binding.id))
          this.stopped.set(binding.id, { bindingId: binding.id, state: "stopped" });
        continue;
      }
      if (this.tasks.has(binding.id)) continue;
      this.stopped.delete(binding.id);
      const task: ListenerTask = {
        finished: false,
        bindingRevision: JSON.stringify(binding),
        abort: new AbortController(),
        done: Promise.resolve(),
        state: { bindingId: binding.id, state: "connecting" },
      };
      this.tasks.set(binding.id, task);
      task.done = this.listen(binding.id, task).finally(() => {
        task.finished = true;
        if (task.abort.signal.aborted) {
          this.stopped.set(binding.id, { bindingId: binding.id, state: "stopped" });
          this.tasks.delete(binding.id);
          this.schedule();
        }
        this.options.store.touch();
      });
    }
  }
  private state(task: ListenerTask, patch: Partial<ScaleSetState>) {
    task.state = { ...task.state, ...patch };
    this.options.store.touch();
  }
  private reservations(bindingId: string, prune = true) {
    let active = 0;
    for (const value of this.options.store.list("scale-set-reservation")) {
      const reservation = Schema.decodeUnknownSync(Reservation)(value);
      try {
        const operation = this.options.store.operationByKey(reservation.key);
        if (operation.status === "accepted" || operation.status === "running") {
          if (reservation.bindingId === bindingId) active++;
        } else if (prune) this.options.store.remove("scale-set-reservation", reservation.key);
      } catch (error) {
        if (!(error instanceof VectisError) || error.code !== "operation_missing") throw error;
        if (!prune) continue;
        const cursor = this.options.store.get("scale-set-cursor", reservation.bindingId);
        if (
          cursor === undefined ||
          !Schema.decodeUnknownSync(Cursor)(cursor).pending?.keys.includes(reservation.key)
        )
          this.options.store.remove("scale-set-reservation", reservation.key);
      }
    }
    return active;
  }
  private slots(bindingId: string) {
    const binding = this.options.repositories()?.find((binding) => binding.id === bindingId);
    return (
      this.options
        .snapshot()
        .runnerCapacity?.environments?.find(
          (environment) => environment.environmentId === binding?.environmentId,
        )?.available ?? 0
    );
  }
  private async listen(bindingId: string, task: ListenerTask) {
    const signal = task.abort.signal;
    let grant: ScaleSetGrant | undefined;
    let failures = 0;
    let broker: ScaleSetBroker | undefined;
    try {
      const binding = this.options.repositories()?.find((binding) => binding.id === bindingId);
      if (restrictiveAccess(binding?.access))
        throw new VectisError(
          "scale_set_policy_unsupported",
          "Scale set preview requires any actor and automatic approval. Use demand mode for restrictive policies.",
        );
      const sessionBroker = this.options.broker();
      broker = sessionBroker;
      for (;;) {
        signal.throwIfAborted();
        try {
          grant = await sessionBroker.openScaleSet(bindingId, signal);
          if (grant.bindingId !== bindingId)
            throw new VectisError(
              "scale_set_binding_mismatch",
              "The scale set grant belongs to another binding.",
            );
          break;
        } catch (error) {
          if (signal.aborted || actionCode(error)) throw error;
          await this.backoff(error, failures++, signal);
        }
      }
      let current = grant;
      const saved = this.options.store.get("scale-set-cursor", bindingId);
      let cursor: Cursor =
        saved === undefined
          ? {
              generation: current.generation,
              sequence: 0,
              lastMessageId: 0,
              assignedJobs: current.statistics?.totalAssignedJobs ?? 0,
            }
          : Schema.decodeUnknownSync(Cursor)(saved);
      if (cursor.generation !== current.generation)
        cursor = {
          generation: current.generation,
          sequence: 0,
          lastMessageId: 0,
          assignedJobs: current.statistics?.totalAssignedJobs ?? 0,
        };
      const save = () => this.options.store.put("scale-set-cursor", bindingId, cursor);
      save();
      let client = (this.options.sessionClient ?? sessionClient)(current);
      const request = async <T>(work: (client: SessionClient) => Promise<T>): Promise<T> => {
        let refreshed = false;
        for (;;) {
          signal.throwIfAborted();
          try {
            const value = await work(client);
            failures = 0;
            return value;
          } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof ScaleSetHttpError && error.queueTokenExpired && !refreshed) {
              refreshed = true;
              for (;;) {
                try {
                  current = await sessionBroker.refreshScaleSet(
                    bindingId,
                    current.generation,
                    signal,
                  );
                  break;
                } catch (refreshError) {
                  if (signal.aborted || actionCode(refreshError)) throw refreshError;
                  await this.backoff(refreshError, failures++, signal);
                }
              }
              if (current.bindingId !== bindingId || current.generation !== grant?.generation)
                throw new VectisError(
                  "scale_set_superseded",
                  "The scale set session was superseded.",
                );
              client = (this.options.sessionClient ?? sessionClient)(current);
              continue;
            }
            if (actionCode(error)) throw error;
            await this.backoff(error, failures++, signal);
          }
        }
      };
      const accept = () => {
        const pending = cursor.pending;
        if (!pending) return;
        for (const key of pending.keys) {
          signal.throwIfAborted();
          this.options.store.put("scale-set-reservation", key, { bindingId, key });
          this.options.submit(key, {
            type: "runner.run",
            bindingId,
            automatic: true,
            scaleSet: { generation: current.generation },
          });
        }
        cursor = {
          ...cursor,
          lastMessageId: pending.messageId,
          assignedJobs: pending.assignedJobs,
          pending: undefined,
        };
        save();
      };
      const reserve = (messageId: number, assignedJobs: number) => {
        const reserved = this.reservations(bindingId);
        // runnerCapacity reports free slots; include this binding's reservations in its ceiling.
        const envSlots = this.slots(bindingId) + reserved;
        const additional = Math.max(0, Math.min(assignedJobs, envSlots) - reserved);
        const keys = Array.from(
          { length: additional },
          (_, index) =>
            `scale-set:${createHash("sha256").update(bindingId).digest("hex").slice(0, 32)}:${current.generation}:${cursor.sequence + index + 1}`,
        );
        cursor = {
          ...cursor,
          sequence: cursor.sequence + additional,
          pending: { messageId, assignedJobs, keys },
        };
        save();
        accept();
      };
      // A persisted plan is replayed with exactly the same request keys after a crash.
      accept();
      reserve(cursor.lastMessageId, cursor.assignedJobs);
      this.state(task, {
        state: "listening",
        scaleSetName: current.scaleSetName,
        assignedJobs: cursor.assignedJobs,
        reservedRunners: this.reservations(bindingId),
      });
      while (!signal.aborted) {
        const active = this.reservations(bindingId);
        const message = await request((client) =>
          client.getMessage(cursor.lastMessageId, this.slots(bindingId) + active, signal),
        );
        signal.throwIfAborted();
        if (!message) {
          reserve(cursor.lastMessageId, cursor.assignedJobs);
          this.state(task, { reservedRunners: this.reservations(bindingId) });
          await wait(250, signal);
          continue;
        }
        if (message.messageId > cursor.lastMessageId) {
          const available = message.jobs.filter(
            (job) => job.messageType === "JobAvailable" && job.runnerRequestId !== undefined,
          );
          for (const job of available) {
            if (job.messageType === "JobAvailable" && job.runnerRequestId !== undefined) {
              const requestId = job.runnerRequestId;
              await request((client) => client.acquireJobs([requestId], signal, job.acquireJobUrl));
            }
          }
          reserve(message.messageId, message.statistics.totalAssignedJobs);
        }
        await request((client) => client.acknowledgeMessage(message.messageId, signal));
        this.state(task, {
          assignedJobs: cursor.assignedJobs,
          reservedRunners: this.reservations(bindingId),
          lastMessageAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      if (!signal.aborted)
        this.state(task, {
          state: "action_required",
          code: actionCode(error) ?? "scale_set_listener_failed",
          message:
            "Scale set listening stopped. Check the binding, policy and cloud authorization before retrying.",
        });
    } finally {
      if (grant && broker) {
        const closing = new AbortController();
        const timer = setTimeout(() => closing.abort(), 10000);
        try {
          await Promise.race([
            broker.closeScaleSet(bindingId, grant.generation, closing.signal).catch(() => {}),
            wait(10000, closing.signal).catch(() => {}),
          ]);
        } finally {
          clearTimeout(timer);
          closing.abort();
        }
      }
    }
  }
  private async backoff(error: unknown, failures: number, signal: AbortSignal) {
    const exponential = Math.min(30000, 500 * 2 ** Math.min(failures, 6));
    const jitter = exponential * (0.5 + (this.options.random ?? Math.random)());
    await wait(Math.min(2147483647, Math.max(retryAfter(error), jitter)), signal);
  }
  async suspend() {
    this.suspended = true;
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.all([...this.tasks.values()].map((task) => task.done));
  }
  resume() {
    this.suspended = false;
    this.schedule();
  }
  async close() {
    this.closing = true;
    this.unsubscribe?.();
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.all([...this.tasks.values()].map((task) => task.done));
  }
}
