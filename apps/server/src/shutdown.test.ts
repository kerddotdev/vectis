import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startService } from "./http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { createServer } from "node:http";
import { once } from "node:events";

test("idle shutdown never falls back to stopping an older service", async () => {
  let stopped = false;
  const legacy = createServer((request, response) => {
    stopped = request.url === "/v1/shutdown";
    response.writeHead(stopped ? 202 : 404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        stopped
          ? { stopping: true }
          : {
              code: "not_found",
              message: "Unsupported endpoint.",
              nextStep: "Use a compatible client.",
            },
      ),
    );
  });
  legacy.listen(0, "127.0.0.1");
  await once(legacy, "listening");
  try {
    const address = legacy.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const client = new VectisClient({ url: `http://127.0.0.1:${address.port}`, token: "test" });
    await expect(client.shutdown({ ifIdle: true })).rejects.toMatchObject({ code: "not_found" });
    expect(stopped).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      legacy.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("idle shutdown refuses active instances and keeps accepting control requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-idle-shutdown-"));
  const stopped = vi.fn();
  const server = await startService({ home, onShutdown: stopped });
  const client = new VectisClient(server.connection);
  try {
    server.store.put("instance", "pending", {
      id: "pending",
      environmentId: "test",
      status: "interrupted",
      pid: 0,
      createdAt: new Date().toISOString(),
    });
    await expect(client.shutdown({ ifIdle: true })).rejects.toMatchObject({ code: "service_busy" });
    expect(stopped).not.toHaveBeenCalled();
    const pause = await client.submit({ type: "machine.pause", paused: true }, "pause");
    expect((await client.wait(pause.id)).status).toBe("succeeded");
    server.store.remove("instance", "pending");
    await expect(client.shutdown({ ifIdle: true })).resolves.toMatchObject({ stopping: true });
    expect(stopped).toHaveBeenCalledOnce();
    await expect(
      client.submit({ type: "machine.pause", paused: false }, "resume"),
    ).rejects.toMatchObject({ code: "service_stopping" });
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("idle shutdown reserves admission atomically with accepted work", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-idle-shutdown-"));
  const server = await startService({ home });
  try {
    server.service.submit("pause", { type: "machine.pause", paused: true });
    expect(() => server.service.beginShutdown(true)).toThrow(
      expect.objectContaining({ code: "service_busy" }),
    );
    await server.service.drain();
    server.service.beginShutdown(true);
    expect(() => server.service.submit("resume", { type: "machine.pause", paused: false })).toThrow(
      expect.objectContaining({ code: "service_stopping" }),
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
