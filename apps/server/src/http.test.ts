import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startService } from "./http.js";
import { VectisClient } from "../../../packages/client/src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-test-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const server = await startService({ home });
  cleanup.push(server.close);
  return { home, server, client: new VectisClient(server.connection) };
}
test("rejects unauthorized and browser-origin requests without exposing state", async () => {
  const { server } = await fixture();
  expect((await fetch(server.connection.url + "/v1/status")).status).toBe(401);
  expect(
    (
      await fetch(server.connection.url + "/v1/status", {
        headers: {
          Authorization: `Bearer ${server.connection.token}`,
          Origin: "https://attacker.example",
        },
      })
    ).status,
  ).toBe(403);
});
test("persists mutations, deduplicates retries, and rejects conflicting keys", async () => {
  const { client, server } = await fixture();
  const first = await client.submit({ type: "machine.pause", paused: true }, "same-key");
  await server.service.drain();
  const second = await client.submit({ type: "machine.pause", paused: true }, "same-key");
  expect(second.id).toBe(first.id);
  expect(second.status).toBe("succeeded");
  expect((await client.status()).machine.paused).toBe(true);
  await expect(
    client.submit({ type: "machine.pause", paused: false }, "same-key"),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});
test("exclusive home ownership prevents a second service", async () => {
  const { home } = await fixture();
  await expect(startService({ home })).rejects.toMatchObject({ code: "already_running" });
});
test("malformed commands cannot mutate state", async () => {
  const { server, client } = await fixture();
  const response = await fetch(server.connection.url + "/v1/commands", {
    method: "POST",
    headers: { Authorization: `Bearer ${server.connection.token}` },
    body: JSON.stringify({ key: "a", command: { type: "machine.pause", paused: "yes" } }),
  });
  expect(response.status).toBe(400);
  expect((await client.status()).machine.paused).toBe(false);
});

test("configuration changes apply to future VMs without changing active resource reservations", async () => {
  const { home, server, client } = await fixture();
  const { writeFile } = await import("node:fs/promises");
  const basePath = join(home, "base.img");
  await writeFile(basePath, "test");
  await mkdir(join(home, "selected-volume"));
  const environment = {
    id: "env",
    name: "Test",
    os: "linux" as const,
    basePath,
    cpu: 1,
    memoryMiB: 512,
    state: "ready" as const,
  };
  await client.submit({ type: "environment.register", environment }, "register");
  await server.service.drain();
  server.store.put("instance", "active", {
    id: "active",
    environmentId: "env",
    status: "running",
    cpu: 1,
    memoryMiB: 512,
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  const operation = await client.submit(
    {
      type: "environment.configure",
      id: "env",
      memoryMiB: 1024,
      storagePath: join(home, "selected-volume"),
    },
    "configure",
  );
  await server.service.drain();
  expect((await client.wait(operation.id)).status).toBe("succeeded");
  const snapshot = await client.status();
  expect(snapshot.environments[0]).toMatchObject({
    memoryMiB: 1024,
    storagePath: join(home, "selected-volume"),
  });
  expect(snapshot.instances[0]?.memoryMiB).toBe(512);
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "per-VM overrides preserve defaults and reject invalid reservations before starting",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "vectis-overrides-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const helper = join(home, "helper");
    await writeFile(
      helper,
      `#!${process.execPath}\nprocess.stdout.write('{"event":"vm.running"}\\n'); setInterval(() => {}, 1000);`,
      { mode: 0o700 },
    );
    const server = await startService({ home, appleHelper: helper });
    cleanup.push(server.close);
    const client = new VectisClient(server.connection);
    const basePath = join(home, "base.img");
    const storagePath = join(home, "selected");
    await writeFile(basePath, "test disk");
    await mkdir(storagePath);
    const environment = {
      id: "test",
      name: "Test",
      os: "linux" as const,
      state: "ready" as const,
      cpu: 2,
      memoryMiB: 1024,
      basePath,
    };
    const registration = await client.submit(
      { type: "environment.register", environment },
      "register",
    );
    expect((await client.wait(registration.id)).status).toBe("succeeded");
    const invalid = await client.submit(
      { type: "environment.start", id: "test", cpu: -10 },
      "invalid",
    );
    expect((await client.wait(invalid.id)).result).toMatchObject({ code: "invalid_resources" });
    expect((await client.status()).instances).toHaveLength(0);
    const start = await client.submit(
      { type: "environment.start", id: "test", cpu: 1, memoryMiB: 512, storagePath },
      "start",
    );
    expect((await client.wait(start.id)).status).toBe("succeeded");
    const snapshot = await client.status();
    expect(snapshot.environments[0]).toEqual(environment);
    expect(snapshot.instances[0]).toMatchObject({ cpu: 1, memoryMiB: 512, status: "running" });
    expect(snapshot.instances[0]?.directory).toBe(
      join(storagePath, snapshot.instances[0]?.id ?? "missing"),
    );
  },
);
