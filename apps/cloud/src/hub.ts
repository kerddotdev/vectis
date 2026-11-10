import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import {
  EnvironmentSlots,
  MachineStatus,
  socketCloseCodes,
} from "../../../packages/protocol/src/cloud.js";
import type { Env } from "./env.js";
import { evaluateDemand } from "./runners/demand.js";

export interface HubPresence {
  online: boolean;
  lastSeenAt: number | null;
  runnerIdle?: boolean;
  runnerSlots?: number;
}
type Status = MachineStatus & { statusAt: number };
type Attachment = { connectedAt: number };
export class MachineHub extends DurableObject<Env> {
  private running = false;
  private rerun = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const id = request.headers.get("X-Vectis-Machine");
    if (!id || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Invalid upgrade", { status: 400 });
    await this.ctx.storage.put("machineId", id);
    await this.disconnect(socketCloseCodes.replaced);
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ connectedAt: Date.now() } satisfies Attachment);
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": "vectis.v1" },
    });
  }

  private seen(socket: WebSocket): number {
    const attachment: Attachment = socket.deserializeAttachment();
    return Math.max(
      attachment.connectedAt,
      this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
    );
  }

  async notify(): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "changed" }));
  }

  async demand(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        const id = await this.ctx.storage.get<string>("machineId");
        const status = await this.ctx.storage.get<Status>("status");
        if (id && status && (await this.presence()).online)
          await evaluateDemand(this.env, id, status);
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  async presence(): Promise<HubPresence> {
    let lastSeenAt = (await this.ctx.storage.get<number>("lastSeenAt")) ?? null;
    let online = false;
    for (const socket of this.ctx.getWebSockets()) {
      const seen = this.seen(socket);
      lastSeenAt = Math.max(lastSeenAt ?? 0, seen);
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (Date.now() - seen < 90000) online = true;
      else {
        socket.close(socketCloseCodes.stale);
        await this.ctx.storage.put("lastSeenAt", lastSeenAt);
      }
    }
    const status = await this.ctx.storage.get<Status>("status");
    return {
      online,
      lastSeenAt,
      ...(status
        ? {
            runnerIdle: status.runnerIdle,
            ...(status.runnerSlots === undefined ? {} : { runnerSlots: status.runnerSlots }),
          }
        : {}),
    };
  }

  async disconnect(code: number): Promise<void> {
    let lastSeenAt = (await this.ctx.storage.get<number>("lastSeenAt")) ?? null;
    for (const socket of this.ctx.getWebSockets()) {
      lastSeenAt = Math.max(lastSeenAt ?? 0, this.seen(socket));
      socket.close(code);
    }
    if (lastSeenAt !== null) await this.ctx.storage.put("lastSeenAt", lastSeenAt);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const seen = this.seen(socket);
    const previous = (await this.ctx.storage.get<number>("lastSeenAt")) ?? 0;
    await this.ctx.storage.put("lastSeenAt", Math.max(seen, previous));
    socket.close();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    const statusAt = Date.now();
    let raw: unknown;
    let status: MachineStatus;
    try {
      raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      if (raw && typeof raw === "object") {
        if (
          ("runnerSlots" in raw &&
            (typeof raw.runnerSlots !== "number" ||
              !Number.isInteger(raw.runnerSlots) ||
              raw.runnerSlots < 0 ||
              raw.runnerSlots > 16)) ||
          ("environmentSlots" in raw && !Schema.is(EnvironmentSlots)(raw.environmentSlots))
        )
          throw new Error("invalid_runner_capacity");
      }
      status = Schema.decodeUnknownSync(MachineStatus, { onExcessProperty: "error" })(raw);
      if (
        new Set(status.environments.map((item) => item.id)).size !== status.environments.length ||
        status.environments.some((item) => !item.name.trim())
      )
        throw new Error("invalid_environment_inventory");
      if (
        status.environmentSlots &&
        new Set(status.environmentSlots.map((item) => item.environmentId)).size !==
          status.environmentSlots.length
      )
        throw new Error("invalid_runner_capacity");
    } catch (error) {
      const seq =
        raw && typeof raw === "object" && "seq" in raw && Number.isInteger(raw.seq) ? raw.seq : 0;
      socket.send(
        JSON.stringify({
          t: "status.rejected",
          seq,
          code:
            error instanceof Error && error.message.startsWith("invalid_")
              ? error.message
              : "invalid_status",
        }),
      );
      return;
    }
    const id = await this.ctx.storage.get<string>("machineId");
    if (!id) return;
    const environmentsJson = JSON.stringify(
      [...status.environments].sort((a, b) => a.id.localeCompare(b.id)),
    );
    await this.env.DB.prepare(
      "UPDATE machines SET paused = ?, environmentsJson = ? WHERE id = ? AND (paused IS NOT ? OR environmentsJson IS NOT ?)",
    )
      .bind(status.paused ? 1 : 0, environmentsJson, id, status.paused ? 1 : 0, environmentsJson)
      .run();
    await this.ctx.storage.put("status", { ...status, statusAt } satisfies Status);
    socket.send(JSON.stringify({ t: "status.ack", seq: status.seq }));
    await this.demand();
  }
}
