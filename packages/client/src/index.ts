import { Schema } from "effect";
import {
  ApiError,
  Operation,
  Snapshot,
  VectisError,
  type Command,
  type Connection,
} from "../../protocol/src/index.js";

export class VectisClient {
  constructor(readonly connection: Pick<Connection, "url" | "token">) {
    const url = new URL(connection.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
      throw new VectisError("insecure_connection", "Connections require HTTPS or local loopback.");
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.connection.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const issue = Schema.decodeUnknownSync(ApiError)(value);
      throw new VectisError(issue.code, issue.message, issue.nextStep);
    }
    return value;
  }
  async status() {
    return Schema.decodeUnknownSync(Snapshot)(await this.request("/v1/status"));
  }
  async capabilities() {
    return this.request("/v1/capabilities");
  }
  async submit(command: Command, key: string) {
    return Schema.decodeUnknownSync(Operation)(
      await this.request("/v1/commands", { key, command }),
    );
  }
  async wait(id: string, signal: AbortSignal = AbortSignal.timeout(120000)): Promise<Operation> {
    while (!signal.aborted) {
      const operation = (await this.status()).operations.find((item) => item.id === id);
      if (!operation) throw new VectisError("operation_missing", "The operation was not found.");
      if (operation.status !== "accepted" && operation.status !== "running") return operation;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            new VectisError(
              "wait_cancelled",
              "Waiting was cancelled; the operation may still be running.",
            ),
          );
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 200);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new VectisError("wait_cancelled", "Waiting was cancelled; inspect operation status.");
  }
}
