import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startService } from "./http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { Snapshot, VectisError } from "../../../packages/protocol/src/index.js";
import { Schema } from "effect";

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
test("an unpaired status snapshot decodes with a stable revision and no repositories", async () => {
  const { client, server } = await fixture();
  const snapshot = await client.status();
  expect(snapshot.revision).toEqual(expect.any(String));
  expect(snapshot.activities).toEqual([]);
  expect(snapshot.revision).toBe(server.service.snapshot().revision);
  expect(snapshot).not.toHaveProperty("repositories");
  expect((await client.status()).revision).toBe(snapshot.revision);
});

test("strict snapshot decoding accepts older services during an app update", async () => {
  const { client, server } = await fixture();
  const legacy = { ...server.service.snapshot() };
  delete legacy.revision;
  delete legacy.activities;
  vi.spyOn(server.service, "snapshot").mockReturnValue(legacy);
  const snapshot = await client.status();
  expect(snapshot.revision).toBeUndefined();
  expect(snapshot.activities ?? []).toEqual([]);
  expect(() =>
    Schema.decodeUnknownSync(Snapshot, { onExcessProperty: "error" })(snapshot),
  ).not.toThrow();
});

test("HTTP callers cannot attach intents to another activity", async () => {
  const { server, client } = await fixture();
  const response = await fetch(`${server.connection.url}/v1/commands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.connection.token}` },
    body: JSON.stringify({
      key: "foreign",
      command: { type: "job.scan", bindingId: "binding", activityId: "someone-else" },
    }),
  });
  expect(response.status).toBe(400);
  expect((await client.status()).activities).toEqual([]);
});

test.each([
  { repositories: [] },
  {
    repositories: [
      {
        id: "binding1",
        repositoryId: 1,
        repositoryName: "owner/repo",
        environmentId: "linux",
        automatic: true,
      },
    ],
  },
])(
  "a paired status snapshot decodes its cached repositories: $repositories",
  async ({ repositories }) => {
    const { client, server } = await fixture();
    vi.spyOn(server.service, "repositorySnapshot").mockReturnValue(repositories);
    expect((await client.status()).repositories).toEqual(repositories);
  },
);
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
      `#!${process.execPath}\nprocess.stdout.write('{"event":"vm.running","macAddress":"02:00:00:00:00:01"}\\n'); setInterval(() => {}, 1000);`,
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
    expect(snapshot.environments[0]).toEqual({
      ...environment,
      network: { egress: "open", enforcement: "not_enforced" },
    });
    expect(snapshot.instances[0]).toMatchObject({
      id: start.id,
      macAddress: "02:00:00:00:00:01",
      cpu: 1,
      memoryMiB: 512,
      status: "running",
    });
    const replay = await client.submit(
      { type: "environment.start", id: "test", cpu: 1, memoryMiB: 512, storagePath },
      "start",
    );
    expect(replay.id).toBe(start.id);
    expect((await client.status()).instances).toHaveLength(1);
    expect(snapshot.instances[0]?.directory).toBe(
      join(storagePath, snapshot.instances[0]?.id ?? "missing"),
    );
  },
);

test("diagnostics report service configuration independently of the client shell", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-doctor-"));
  const server = await startService({ home, appleHelper: "/isolated/apple-helper" });
  try {
    const api = new VectisClient(server.connection);
    expect(await api.doctor()).toMatchObject({
      source: "service",
      home,
      configured: { appleHelper: true, qemu: false },
    });
    const response = await fetch(`${server.connection.url}/v1/doctor`);
    expect(response.status).toBe(401);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("repository discovery reports missing cloud configuration instead of an empty success", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-repositories-"));
  const server = await startService({ home });
  try {
    const api = new VectisClient(server.connection);
    await expect(api.repositories()).rejects.toMatchObject({ code: "cloud_unconfigured" });
    expect((await fetch(`${server.connection.url}/v1/repositories`)).status).toBe(401);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an accepted shutdown stops advertising readiness before the listener closes", async () => {
  const { client, server } = await fixture();
  await client.shutdown({ ifIdle: true });
  await expect(client.status()).rejects.toMatchObject({ code: "service_closing" });
  const response = await fetch(server.connection.url + "/v1/status", {
    headers: { Authorization: `Bearer ${server.connection.token}` },
  });
  expect(response.status).toBe(503);
});

test("machine runner limits reject invalid values and survive a service restart", async () => {
  const { home, server, client } = await fixture();
  expect((await client.status()).runnerCapacity).toEqual({ max: 5, active: 0, available: 0 });
  for (const maxRunners of [0, 17, -1, 1.5, "5"]) {
    const response = await fetch(server.connection.url + "/v1/commands", {
      method: "POST",
      headers: { Authorization: `Bearer ${server.connection.token}` },
      body: JSON.stringify({
        key: `invalid-${maxRunners}`,
        command: { type: "machine.configure", maxRunners },
      }),
    });
    expect(response.status).toBe(400);
  }
  for (const maxRunners of [1, 16, 3]) {
    const operation = await client.settle(
      { type: "machine.configure", maxRunners },
      `limit-${maxRunners}`,
    );
    expect(operation.status).toBe("succeeded");
    const state = await client.status();
    expect(state.machine.maxRunners).toBe(maxRunners);
    expect(state.runnerCapacity).toEqual({ max: maxRunners, active: 0, available: 0 });
    expect(state.activities).toEqual([]);
  }
  await server.close();
  cleanup.pop();
  const restarted = await startService({ home });
  cleanup.push(restarted.close);
  const state = await new VectisClient(restarted.connection).status();
  expect(state.machine.maxRunners).toBe(3);
  expect(state.runnerCapacity?.max).toBe(3);
});

test("task failures are redacted in storage and the logs query before any display", async () => {
  const { home, server, client } = await fixture();
  const canary = "ghp_TaskFailureCanary123456789";
  const error = new VectisError(
    "runtime_missing",
    `failed ${canary} exit 23`,
    `token=${canary} inspect /tmp/runner`,
  );
  const validation = vi.spyOn(server.service.runtime, "validate").mockRejectedValue(error);
  server.store.put("environment", "test", {
    id: "test",
    name: "Runner",
    os: "linux",
    state: "ready",
    cpu: 1,
    memoryMiB: 512,
    basePath: join(home, "base.img"),
  });
  try {
    const operation = await client.submit({ type: "environment.start", id: "test" }, "canary-task");
    await server.service.drain();
    await vi.waitFor(() =>
      expect(server.store.get("operation", operation.id)).toMatchObject({
        status: "action_required",
        message: "failed [redacted] exit 23",
        result: { nextStep: "token=[redacted] inspect /tmp/runner" },
      }),
    );
    expect(validation).toHaveBeenCalledOnce();
    const row = server.store.db
      .prepare("SELECT body FROM records WHERE kind='operation' AND id=?")
      .get(operation.id);
    expect(row?.body).not.toContain(canary);
    expect(JSON.stringify(await client.operation(operation.id))).not.toContain(canary);
    await writeFile(join(home, "service.log"), `${error.message}\n${error.nextStep}\n`);
    expect(await client.logs()).toEqual({
      lines: ["failed [redacted] exit 23", "token=[redacted] inspect /tmp/runner"],
      truncated: false,
    });
  } finally {
    validation.mockRestore();
  }
});

test("request errors redact credentials even when no operation was accepted", async () => {
  const { server, client } = await fixture();
  const canary = "RequestErrorCanary123456789";
  const submit = vi.spyOn(server.service, "submit").mockImplementation(() => {
    throw new VectisError(
      "request_failed",
      `secret=${canary}`,
      `token=${canary} inspect /tmp/runner`,
    );
  });
  try {
    await expect(
      client.submit({ type: "machine.pause", paused: true }, "rejected"),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: "secret=[redacted]",
      nextStep: "token=[redacted] inspect /tmp/runner",
    });
    expect(server.store.snapshot().operations).toEqual([]);
  } finally {
    submit.mockRestore();
  }
});

test("Linux Rosetta configuration persists, survives resource updates and off removes it", async () => {
  const { home, server, client } = await fixture();
  const basePath = join(home, "base.img");
  await writeFile(basePath, "synthetic Linux image");
  await client.submit(
    {
      type: "environment.register",
      environment: {
        id: "linux",
        name: "Linux",
        os: "linux",
        basePath,
        cpu: 1,
        memoryMiB: 512,
        state: "ready",
      },
    },
    "register",
  );
  await server.service.drain();
  for (const [key, configuration] of [
    ["enable", { x64: "rosetta" }],
    ["resources", { memoryMiB: 1024 }],
    ["disable", { x64: "off" }],
  ] as const) {
    const operation = await client.submit(
      { type: "environment.configure", id: "linux", ...configuration },
      key,
    );
    await server.service.drain();
    expect((await client.wait(operation.id)).status).toBe("succeeded");
    const environment = (await client.status()).environments[0];
    if (key === "disable") expect(environment).not.toHaveProperty("x64");
    else expect(environment?.x64).toBe("rosetta");
  }
});

test.each(["macos", "windows"] as const)("%s rejects Rosetta with a coded error", async (os) => {
  const { home, server, client } = await fixture();
  const basePath = join(home, "base");
  if (os === "macos") await mkdir(basePath);
  else await writeFile(basePath, "synthetic Windows image");
  server.store.put("environment", os, {
    id: os,
    name: os,
    os,
    basePath,
    cpu: 1,
    memoryMiB: 512,
    state: "ready",
  });
  const operation = await client.submit(
    { type: "environment.configure", id: os, x64: "rosetta" },
    "enable",
  );
  await server.service.drain();
  expect(await client.wait(operation.id)).toMatchObject({
    status: "failed",
    result: { code: "unsupported" },
    message: expect.stringContaining("only for Linux"),
  });
  expect((await client.status()).environments[0]).not.toHaveProperty("x64");
  const off = await client.submit({ type: "environment.configure", id: os, x64: "off" }, "off");
  await server.service.drain();
  expect((await client.wait(off.id)).status).toBe("succeeded");
});

test("Rosetta host and guest startup failures remain action required on the service", async () => {
  const { home, server, client } = await fixture();
  const { VectisError } = await import("../../../packages/protocol/src/index.js");
  const basePath = join(home, "base.img");
  await writeFile(basePath, "synthetic Linux image");
  server.store.put("environment", "linux", {
    id: "linux",
    name: "Linux",
    os: "linux",
    basePath,
    cpu: 1,
    memoryMiB: 512,
    state: "ready",
    x64: "rosetta",
  });
  const start = vi.spyOn(server.service.runtime, "start");
  try {
    for (const code of [
      "rosetta_not_installed",
      "rosetta_unsupported",
      "rosetta_guest_unprepared",
    ]) {
      start.mockRejectedValueOnce(
        new VectisError(code, "Rosetta needs attention.", "Resolve Rosetta setup."),
      );
      const operation = await client.submit({ type: "environment.start", id: "linux" }, code);
      await server.service.drain();
      expect(await client.wait(operation.id)).toMatchObject({
        status: "action_required",
        result: { code, nextStep: "Resolve Rosetta setup." },
      });
    }
  } finally {
    start.mockRestore();
  }
});

test("invalid x64 values are rejected at the protocol boundary before mutation", async () => {
  const { server } = await fixture();
  const response = await fetch(`${server.connection.url}/v1/commands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.connection.token}` },
    body: JSON.stringify({
      key: "invalid-x64",
      command: { type: "environment.configure", id: "linux", x64: "qemu" },
    }),
  });
  expect(response.status).toBe(400);
  expect(server.service.snapshot().operations).toEqual([]);
});
