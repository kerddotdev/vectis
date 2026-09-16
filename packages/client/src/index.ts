import { Jobs } from "../../protocol/src/jobs.js";
import { Schema } from "effect";
import { GitHubAccounts, MachineRepositories } from "../../protocol/src/repositories.js";
import { Diagnostics } from "../../protocol/src/diagnostics.js";
import { StorageReport } from "../../protocol/src/storage.js";
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
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL(path, this.connection.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      redirect: "error",
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const issue = Schema.decodeUnknownSync(ApiError)(value);
      throw new VectisError(issue.code, issue.message, issue.nextStep);
    }
    return value;
  }
  async status(signal?: AbortSignal) {
    return Schema.decodeUnknownSync(Snapshot)(await this.request("/v1/status", undefined, signal));
  }
  async reloadCloud() {
    return this.request("/v1/cloud/reload", {});
  }
  async shutdown() {
    return this.request("/v1/shutdown", {});
  }
  async jobs(bindingId: string) {
    return Schema.decodeUnknownSync(Jobs)(
      await this.request(`/v1/jobs?bindingId=${encodeURIComponent(bindingId)}`),
    );
  }
  async githubAccounts() {
    return Schema.decodeUnknownSync(GitHubAccounts)(await this.request("/v1/github/accounts"));
  }
  async repositories() {
    return Schema.decodeUnknownSync(MachineRepositories)(await this.request("/v1/repositories"));
  }
  async doctor() {
    return Schema.decodeUnknownSync(Diagnostics)(await this.request("/v1/doctor"));
  }
  async storage() {
    return Schema.decodeUnknownSync(StorageReport)(await this.request("/v1/storage"));
  }
  async capabilities() {
    return this.request("/v1/capabilities");
  }
  async submit(command: Command, key: string, signal?: AbortSignal) {
    return Schema.decodeUnknownSync(Operation)(
      await this.request("/v1/commands", { key, command }, signal),
    );
  }
  async wait(id: string, signal: AbortSignal = AbortSignal.timeout(120000)): Promise<Operation> {
    while (!signal.aborted) {
      const snapshot = await this.status(signal).catch((error) => {
        if (signal.aborted)
          throw new VectisError(
            "wait_cancelled",
            "Waiting was cancelled; the operation may still be running.",
          );
        throw error;
      });
      const operation = snapshot.operations.find((item) => item.id === id);
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
        if (signal.aborted) onAbort();
      });
    }
    throw new VectisError("wait_cancelled", "Waiting was cancelled; inspect operation status.");
  }
}
