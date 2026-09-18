import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  capabilities,
  Request,
  ShutdownOptions,
  VectisError,
  type Connection,
  type CloudStatus,
} from "../../../packages/protocol/src/index.js";
import { runtimeDiagnostics } from "../../../packages/runner/src/diagnostics.js";
import { storageReport } from "../../../packages/runner/src/storage.js";
import { Store } from "./store.js";
import { Service } from "./service.js";
import { VmRuntime, type RuntimeOptions } from "../../../packages/runner/src/runtime.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { configuredRelay } from "./cloud.js";

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 1024 * 1024) throw new VectisError("payload_too_large", "Request exceeds 1 MiB.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new VectisError("invalid_json", "Request body is not valid JSON.");
  }
}
export async function startService(
  options: RuntimeOptions & {
    port?: number;
    token?: string;
    keychainHelper?: string;
    onShutdown?: () => void;
  },
) {
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const lockPath = join(options.home, "service.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8").catch(() => "null"));
    const owner = Schema.decodeUnknownOption(Schema.Struct({ pid: Schema.Int }))(value);
    if (owner._tag === "Some") {
      try {
        process.kill(owner.value.pid, 0);
        throw new VectisError("already_running", "A service already owns this home.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
      await rm(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    } else
      throw new VectisError(
        "invalid_lock",
        "The service lock cannot be verified.",
        "Inspect the isolated home before removing the stale lock.",
      );
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  const token = options.token ?? randomBytes(32).toString("hex");
  const store = new Store(join(options.home, "state.sqlite"));
  const service = new Service(
    store,
    new VmRuntime(options),
    () => {
      if (!relay)
        throw new VectisError(
          "cloud_unconfigured",
          "Connect this machine before starting runners.",
        );
      return relay;
    },
    options.keychainHelper ? new KeychainCredentials(options.keychainHelper) : undefined,
  );
  let cloud: CloudStatus = { state: "unconfigured" };
  let relay: Awaited<ReturnType<typeof configuredRelay>>;
  let connection: Connection | undefined;
  let closing = false;
  const storageAbort = new AbortController();
  let storageInspection: ReturnType<typeof storageReport> | undefined;
  const inspectStorage = () => {
    if (closing) throw new VectisError("service_closing", "The service is shutting down.");
    storageInspection ??= storageReport(
      store.snapshot(),
      options.home,
      storageAbort.signal,
    ).finally(() => {
      storageInspection = undefined;
    });
    return storageInspection;
  };
  let relayUpdate = Promise.resolve();
  const reload = () => {
    const current = relayUpdate.then(async () => {
      if (closing || !connection) throw new Error("Service is not ready for cloud reload.");
      await relay?.close();
      relay = await configuredRelay(
        options.home,
        new VectisClient(connection),
        options.keychainHelper,
        (value) => {
          cloud = value;
        },
      );
    });
    relayUpdate = current.catch(() => {});
    return current;
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.origin || request.headers["sec-fetch-site"] === "cross-site")
        return reply(response, 403, {
          code: "origin_denied",
          message: "Browser origins are not allowed.",
          nextStep: "Use the Vectis client.",
        });
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return reply(response, 401, {
          code: "unauthorized",
          message: "Invalid local session.",
          nextStep: "Reload the local service connection.",
        });
      if (request.method === "POST" && request.url === "/v1/cloud/reload") {
        await reload();
        reply(response, 200, { cloud });
        return;
      }
      if (
        request.method === "POST" &&
        (request.url === "/v1/shutdown" || request.url === "/v1/shutdown-if-idle")
      ) {
        const shutdown = Schema.decodeUnknownSync(ShutdownOptions, { onExcessProperty: "error" })(
          await body(request),
        );
        service.beginShutdown(request.url === "/v1/shutdown-if-idle" || (shutdown.ifIdle ?? false));
        reply(response, 202, { stopping: true });
        options.onShutdown?.();
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/jobs?")) {
        const bindingId = new URL(request.url, "http://127.0.0.1").searchParams.get("bindingId");
        if (!bindingId)
          throw new VectisError("invalid_request", "Provide a repository binding ID.");
        if (!relay)
          throw new VectisError("cloud_unconfigured", "Connect this machine before reading jobs.");
        return reply(response, 200, await relay.jobs(bindingId));
      }
      if (request.method === "GET" && request.url === "/v1/github/accounts") {
        if (!relay)
          throw new VectisError(
            "cloud_unconfigured",
            "Connect this machine before reading linked GitHub accounts.",
          );
        return reply(response, 200, await relay.githubAccounts());
      }
      if (request.method === "GET" && request.url === "/v1/repositories") {
        if (!relay)
          throw new VectisError(
            "cloud_unconfigured",
            "This machine is not connected to Vectis.",
            "Run vectis cloud pair and complete browser approval.",
          );
        return reply(response, 200, await relay.repositories());
      }
      if (request.method === "GET" && request.url === "/v1/doctor")
        return reply(response, 200, runtimeDiagnostics(options, "service"));
      if (request.method === "GET" && request.url === "/v1/storage")
        return reply(response, 200, await inspectStorage());
      if (request.method === "GET" && request.url === "/v1/status")
        return reply(response, 200, { ...store.snapshot(), cloud });
      if (request.method === "GET" && request.url === "/v1/capabilities")
        return reply(response, 200, { protocolVersion: 1, capabilities });
      if (request.method === "POST" && request.url === "/v1/commands") {
        let input;
        try {
          input = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(
            await body(request),
          );
        } catch (error) {
          if (error instanceof VectisError) throw error;
          throw new VectisError("invalid_request", "Request does not match the protocol.");
        }
        return reply(response, 202, service.submit(input.key, input.command));
      }
      reply(response, 404, {
        code: "not_found",
        message: "Unknown endpoint.",
        nextStep: "Run vectis capabilities.",
      });
    })().catch((error) => {
      const issue =
        error instanceof VectisError
          ? error
          : new VectisError("internal_error", "The service could not process the request.");
      reply(response, issue.code === "idempotency_conflict" ? 409 : 400, {
        code: issue.code,
        message: issue.message,
        nextStep: issue.nextStep,
      });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await service.initialize();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address.");
    connection = {
      protocolVersion: 1,
      url: `http://127.0.0.1:${address.port}`,
      token,
      pid: process.pid,
    };
    await writeFile(join(options.home, "connection.json"), JSON.stringify(connection), {
      mode: 0o600,
    });
    await reload();
    return {
      connection,
      store,
      service,
      close: async () => {
        closing = true;
        storageAbort.abort();
        await storageInspection;
        await relayUpdate;
        await service.close();
        await relay?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        await rm(join(options.home, "connection.json"), { force: true });
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    storageAbort.abort();
    await storageInspection;
    await relay?.close();
    server.close();
    await service.close();
    store.close();
    await rm(lockPath, { force: true });
    throw error;
  }
}
