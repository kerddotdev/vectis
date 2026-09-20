import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { VectisClient } from "./index.js";
import { startService } from "../../../apps/server/src/http.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-client-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const server = await startService({ home });
  cleanup.push(server.close);
  return { server, client: new VectisClient(server.connection) };
}

test("settle returns only after the submitted change is applied", async () => {
  const { client } = await fixture();
  const operation = await client.settle({ type: "machine.pause", paused: true }, "pause");
  expect(operation).toMatchObject({ key: "pause", status: "succeeded" });
  expect((await client.status()).machine.paused).toBe(true);
  expect(await client.settle({ type: "machine.pause", paused: true }, "pause")).toEqual(operation);
});

test("settle returns failed operations so callers can inspect the outcome", async () => {
  const { client } = await fixture();
  const operation = await client.settle(
    { type: "environment.configure", id: "missing" },
    "configure",
  );
  expect(operation).toMatchObject({ key: "configure", status: "failed" });
  expect((await client.status()).environments).toEqual([]);
});

test("settle surfaces submission errors instead of waiting for unrelated work", async () => {
  const { client } = await fixture();
  await client.settle({ type: "machine.pause", paused: true }, "pause");
  await expect(
    client.settle({ type: "machine.pause", paused: false }, "pause"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect((await client.status()).machine.paused).toBe(true);
});

test("settle times out without cancelling the submitted operation", async () => {
  const { client, server } = await fixture();
  const command = { type: "machine.pause", paused: true } as const;
  const { operation } = server.store.accept(
    "pending",
    createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    command.type,
  );
  await expect(client.settle(command, "pending", AbortSignal.timeout(50))).rejects.toMatchObject({
    code: "wait_cancelled",
  });
  expect((await client.operation(operation.id)).status).toBe("accepted");
});

test("cancelling an operation wait aborts its in-flight HTTP request", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  const client = new VectisClient({
    url: `http://127.0.0.1:${address.port}`,
    token: "isolated-test",
  });
  try {
    await expect(client.wait("operation", AbortSignal.timeout(50))).rejects.toMatchObject({
      code: "wait_cancelled",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
