import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { startService } from "../../server/src/http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { VectisError, type Snapshot } from "../../../packages/protocol/src/index.js";
import { RemoteClient } from "../../../packages/client/src/remote.js";
import { controllerClient } from "../../../packages/client/src/controller.js";
import { activityFor } from "../../server/src/activities.js";
import type { RunnerProgress } from "../../../packages/protocol/src/runners.js";

function expectToolError(value: unknown, code: string, nextStep?: RegExp) {
  const result = CallToolResultSchema.parse(value);
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code, message: expect.stringMatching(/\S/), nextStep: expect.stringMatching(/\S/) },
    },
  });
  const error = result.structuredContent?.error;
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(error) }]);
  if (nextStep) expect(error).toHaveProperty("nextStep", expect.stringMatching(nextStep));
}

function expectTextResult(value: unknown) {
  const result = CallToolResultSchema.parse(value);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toHaveProperty("result");
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
}

async function withClient(
  server: ReturnType<typeof createMcpServer>,
  run: (client: Client) => Promise<void>,
) {
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP machine discovery reports login and response errors in text and structured content", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-machine-list-"));
  const get = vi.fn().mockRejectedValue(new Error("Unexpected credential lookup"));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("Unexpected controller request"));
  vi.stubGlobal("fetch", fetcher);
  const connect = vi.fn().mockRejectedValue(new Error("Unexpected local service connection"));
  const server = createMcpServer(connect, undefined, undefined, undefined, async () =>
    (await controllerClient(home, { get })).request({ type: "machines.list" }),
  );
  const client = new Client({ name: "machine-list-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await writeFile(
      join(home, "cloud.json"),
      JSON.stringify({
        deploymentUrl: "https://isolated-test.example.com",
        machineId: "machine-1",
        localId: "local-1",
      }),
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = (await client.listTools()).tools.find(({ name }) => name === "vectis_machines");
    expectToolError(
      await client.callTool({ name: "vectis_machines" }),
      "not_signed_in",
      /vectis login.*vectis_status/,
    );
    expect(listed?.description).toMatch(/vectis login.*vectis_status/);
    expect(connect).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    await writeFile(
      join(home, "controller.json"),
      JSON.stringify({
        deploymentUrl: "https://isolated-test.example.com",
        controllerId: "controller-1",
        expiresAt: Date.now() + 60000,
      }),
    );
    get.mockResolvedValueOnce("fixture-secret");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 502 }));
    expectToolError(
      await client.callTool({ name: "vectis_machines" }),
      "controller_invalid_response",
    );

    get.mockResolvedValue("fixture-secret");
    fetcher.mockResolvedValueOnce(Response.json([]));
    const empty = await client.callTool({ name: "vectis_machines" });
    expectTextResult(empty);
    expect(empty.structuredContent).toEqual({ result: [] });

    const environment = {
      id: "b",
      name: "Linux",
      os: "linux",
      state: "ready",
      cpu: 2,
      memoryMiB: 512,
    };
    const machine = {
      id: "z",
      name: "Mac",
      localId: "local",
      paused: false,
      online: true,
      lastSeenAt: 1000,
      environments: [environment, { ...environment, id: "a" }],
    };
    const other = { ...machine, id: "a", online: false, lastSeenAt: null, environments: [] };
    fetcher.mockResolvedValueOnce(Response.json([machine, other]));
    const first = await client.callTool({ name: "vectis_machines" });
    expectTextResult(first);
    expect(first.structuredContent).toEqual({
      result: [other, { ...machine, environments: machine.environments.toReversed() }],
    });
    fetcher.mockResolvedValueOnce(
      Response.json([other, { ...machine, environments: machine.environments.toReversed() }]),
    );
    expect(await client.callTool({ name: "vectis_machines" })).toEqual(first);
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP detail reads preserve runner phases while status stays compact", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-phases-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "phase-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const command = { type: "runner.run", bindingId: "binding" } as const;
    const operation = service.store.accept(
      "runner",
      "runner",
      command.type,
      activityFor("runner", command),
      "runner",
    ).operation;
    const result: RunnerProgress = {
      bindingId: "binding",
      environmentId: "linux",
      leaseKey: operation.id,
      stage: "finished",
      phases: [{ name: "vm_start", startedAt: operation.createdAt, endedAt: operation.createdAt }],
    };
    service.store.update(operation, { status: "succeeded", result });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      await client.callTool({ name: "vectis_operation", arguments: { id: operation.id } }),
    ).toMatchObject({
      content: [],
      structuredContent: { result: { result } },
    });
    expect(
      await client.callTool({ name: "vectis_activity", arguments: { id: "runner" } }),
    ).toMatchObject({
      content: [],
      structuredContent: { result: { operations: [expect.objectContaining({ result })] } },
    });
    const status = await client.callTool({ name: "vectis_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    expectTextResult(status);
    expect(status).toHaveProperty("structuredContent.result.operations", [
      {
        id: operation.id,
        activityId: "runner",
        command: "runner.run",
        status: "succeeded",
        updatedAt: expect.any(String),
        message: expect.any(String),
      },
    ]);
    expect(JSON.stringify(status)).not.toContain('"phases"');
    expect(status).toHaveProperty(
      "structuredContent.result.details",
      expect.stringContaining("vectis_operation"),
    );
  } finally {
    await client.close();
    await server.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP discovers and executes the same authenticated commands as the CLI client", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "isolated-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const discovered = (await client.listTools()).tools;
    expect(discovered.map((tool) => tool.name)).toContain("vectis_command");
    expect(
      JSON.stringify(discovered.find((tool) => tool.name === "vectis_command")?.inputSchema),
    ).toContain("repository.access");
    expect(
      await client.callTool({
        name: "vectis_readiness",
        arguments: { repositoryName: "owner/repo" },
      }),
    ).toMatchObject({
      structuredContent: {
        result: {
          ready: false,
          checks: expect.arrayContaining([expect.objectContaining({ code: "cloud_unconfigured" })]),
        },
      },
    });
    expect(
      await client.callTool({
        name: "vectis_readiness",
        arguments: { repositoryName: "owner/repo", bindingId: "binding" },
      }),
    ).toMatchObject({ isError: true });
    const schema = JSON.stringify(
      discovered.find((tool) => tool.name === "vectis_command")?.inputSchema,
    );
    const discovery = await client.callTool({ name: "vectis_capabilities", arguments: {} });
    for (const name of [
      "run.rerun-failed",
      "run.cancel",
      "workflow.dispatch",
      "repository.cache",
      "cache.clear",
      "repository.capacity-mode",
    ]) {
      expect(schema).toContain(name);
      expect(JSON.stringify(discovery.structuredContent)).toContain(name);
    }
    expect((await api.status()).operations).toEqual([]);
    const args = { key: "mcp-pause", command: { type: "machine.pause", paused: true } };
    const accepted = await client.callTool({ name: "vectis_command", arguments: args });
    expect(accepted.isError).not.toBe(true);
    await service.service.drain();
    const retried = await client.callTool({ name: "vectis_command", arguments: args });
    expect(retried).toMatchObject({
      structuredContent: { result: { key: "mcp-pause", status: "succeeded" } },
    });
    expect((await api.status()).operations).toHaveLength(1);
    const configured = await client.callTool({
      name: "vectis_command",
      arguments: { key: "mcp-configure", command: { type: "machine.configure", maxRunners: 3 } },
    });
    expect(configured.isError).not.toBe(true);
    await service.service.drain();
    expect((await api.status()).machine.maxRunners).toBe(3);
    const commandTool = discovered.find((tool) => tool.name === "vectis_command");
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"x64"');
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"rosetta"');
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"off"');
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"egress"');
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"internet_only"');
    expect(JSON.stringify(commandTool?.inputSchema)).toContain('"open"');
    const basePath = join(home, "base.img");
    await writeFile(basePath, "synthetic Linux image");
    service.store.put("environment", "linux", {
      id: "linux",
      name: "Linux",
      os: "linux",
      state: "ready",
      basePath,
      cpu: 1,
      memoryMiB: 512,
    });
    for (const x64 of ["rosetta", "off"]) {
      const configured = await client.callTool({
        name: "vectis_command",
        arguments: {
          key: `mcp-x64-${x64}`,
          command: { type: "environment.configure", id: "linux", x64 },
        },
      });
      expect(configured.isError).not.toBe(true);
      await service.service.drain();
      expect((await api.status()).environments[0]?.x64).toBe(
        x64 === "rosetta" ? "rosetta" : undefined,
      );
    }
    for (const egress of ["open", "internet_only"]) {
      const accepted = await client.callTool({
        name: "vectis_command",
        arguments: {
          key: `mcp-egress-${egress}`,
          command: { type: "environment.configure", id: "linux", egress },
        },
      });
      expect(accepted.isError).not.toBe(true);
      await service.service.drain();
      const operations = (await api.status()).operations;
      expect(
        operations.find((operation) => operation.key === `mcp-egress-${egress}`),
      ).toMatchObject(
        egress === "open"
          ? { status: "succeeded", result: { environment: { egress: "open" } } }
          : { status: "failed", result: { code: "egress_unsupported" } },
      );
    }
    expect(await client.callTool({ name: "vectis_doctor", arguments: {} })).toMatchObject({
      structuredContent: { result: { source: "service" } },
    });
    expect(await client.callTool({ name: "vectis_repositories", arguments: {} })).toMatchObject({
      isError: true,
    });
    const status = await client.callTool({ name: "vectis_status", arguments: {} });
    expect(status).toMatchObject({
      structuredContent: {
        result: {
          machine: { paused: true },
          environments: [{ network: { egress: "open", enforcement: "not_enforced" } }],
        },
      },
    });
  } finally {
    await client.close();
    await server.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});
test("discovery remains available without a running service and errors explain recovery", async () => {
  const server = createMcpServer(async () => {
    throw new VectisError(
      "service_unavailable",
      "Service unavailable.",
      "Run vectis service start.",
    );
  });
  const client = new Client({ name: "isolated-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      (await client.callTool({ name: "vectis_capabilities", arguments: {} })).isError,
    ).not.toBe(true);
    expect(await client.callTool({ name: "vectis_status", arguments: {} })).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "service_unavailable", nextStep: "Run vectis service start." },
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test.skipIf(process.platform !== "darwin")(
  "MCP login registration discovery works without a running service",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vectis-mcp-login-"));
    const { LaunchAgent } = await import("../../../packages/client/src/launch-agent.js");
    const server = createMcpServer(
      async () => {
        throw new Error("The service must not be contacted.");
      },
      () => LaunchAgent.forHome(join(root, "state"), { directory: root }),
    );
    const client = new Client({ name: "isolated-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("vectis_service");
      expect(
        await client.callTool({ name: "vectis_service", arguments: { action: "status" } }),
      ).toMatchObject({
        structuredContent: { result: { installed: false, loaded: false } },
      });
      expect(
        await client.callTool({ name: "vectis_service", arguments: { action: "erase" } }),
      ).toMatchObject({ isError: true });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("remote MCP sessions expose their target and cannot invoke local service management", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-target-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const server = createMcpServer(async () => api, undefined, undefined, "remote-test-machine");
  const client = new Client({ name: "isolated-remote-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("vectis_service");
    expect(names).not.toContain("vectis_cloud");
    expect(await client.callTool({ name: "vectis_capabilities", arguments: {} })).toMatchObject({
      structuredContent: {
        result: { target: { type: "remote", machineId: "remote-test-machine" } },
      },
    });
    expect(
      await client.callTool({ name: "vectis_service", arguments: { action: "stop" } }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "unsupported_tool" } },
    });
    expect((await api.status()).machine).toBeDefined();
  } finally {
    await client.close();
    await server.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP jobs validate their output and sort newest first with stable ties", async () => {
  const api = new VectisClient({ url: "http://127.0.0.1:1", token: "synthetic" });
  const job = {
    jobId: 4,
    runId: 5,
    name: "Build",
    status: "queued",
    conclusion: null,
    labels: ["vectis-mac", "macOS"],
    runnerId: null,
    runnerName: null,
    updatedAt: 1,
    access: "approval_required",
  } as const;
  const newer = { ...job, jobId: 9, updatedAt: 2 };
  const tied = { ...job, jobId: 7 };
  const jobs = vi
    .spyOn(api, "jobs")
    .mockResolvedValueOnce([tied, job, newer])
    .mockResolvedValueOnce([newer, { ...job, labels: job.labels.toReversed() }, tied])
    .mockResolvedValueOnce([]);
  await withClient(
    createMcpServer(async () => api),
    async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.find(({ name }) => name === "vectis_jobs")?.outputSchema).toBeDefined();
      const call = () =>
        client.callTool({ name: "vectis_jobs", arguments: { bindingId: "binding" } });
      const first = await call();
      expectTextResult(first);
      expect(first).toHaveProperty(
        "structuredContent.result",
        [newer, job, tied].map((item) => ({ ...item, labels: item.labels.toReversed() })),
      );
      expect(await call()).toEqual(first);
      const empty = await call();
      expectTextResult(empty);
      expect(empty.structuredContent).toEqual({ result: [] });
      expectToolError(
        await client.callTool({
          name: "vectis_jobs",
          arguments: { bindingId: { token: "private" } },
        }),
        "invalid_request",
        /input schema/,
      );
      expect(jobs).toHaveBeenCalledTimes(3);
    },
  );
});

test("MCP job logs forwards the byte cursor and rejects invalid requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-job-logs-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const read = vi.spyOn(service.service, "jobLogs").mockResolvedValue({
    text: "failure\n",
    next: 18,
    status: "completed",
    complete: true,
    truncated: false,
  });
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "test-job-logs", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "vectis_job_logs");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain("Pass next as after");
    expect(
      await client.callTool({
        name: "vectis_job_logs",
        arguments: { bindingId: "binding1", jobId: 4, after: 10 },
      }),
    ).toMatchObject({
      structuredContent: { result: { text: "failure\n", next: 18, complete: true } },
    });
    expect(read).toHaveBeenCalledWith(
      { bindingId: "binding1", jobId: 4, after: 10 },
      expect.any(AbortSignal),
    );
    expect(
      await client.callTool({
        name: "vectis_job_logs",
        arguments: { bindingId: "binding1", jobId: 4, after: -1 },
      }),
    ).toMatchObject({ isError: true });
    expect(read).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
    await client.close();
    await server.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP status bounds retained history in both result formats", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-bounded-"));
  const snapshotLimits = { operations: 21, activities: 21, stoppedInstances: 2 };
  const service = await startService({ home, snapshotLimits });
  const api = new VectisClient(service.connection);
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "bounded-status-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const command = { type: "job.scan", bindingId: "binding" } as const;
    service.store.db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < snapshotLimits.operations + 2; index++) {
      const id = `history-${index}`;
      const link = activityFor(id, command);
      service.store.put("activity", id, link?.create);
      service.store.put("operation", id, {
        id,
        key: id,
        command: command.type,
        activityId: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: index === 0 ? "action_required" : "succeeded",
        result: { largeResult: "x".repeat(4096) },
        message: "x".repeat(1024),
      });
    }
    service.store.db.exec("COMMIT");
    expect(Buffer.byteLength(JSON.stringify(await api.status()))).toBeGreaterThan(64 * 1024);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "vectis_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expectTextResult(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(result).toMatchObject({
      structuredContent: {
        result: {
          operations: expect.any(Array),
          activities: expect.any(Array),
          counts: {
            operations: { total: 22, byStatus: { action_required: 1, succeeded: 21 } },
            activities: { total: 22, byStatus: { action_required: 1, succeeded: 21 } },
          },
          details: expect.stringContaining("vectis_operation"),
        },
      },
    });
    expect(result).toHaveProperty("structuredContent.result.operations.length", 20);
    expect(result).toHaveProperty("structuredContent.result.activities.length", 20);
    expect(JSON.stringify(result)).not.toContain("largeResult");
    const status = vi.spyOn(api, "status").mockRejectedValue(new Error("Unexpected status read"));
    const activities = await client.callTool({
      name: "vectis_activities",
      arguments: { status: "action_required" },
    });
    expect(activities).toMatchObject({
      content: [],
      structuredContent: { result: [{ id: "history-0" }] },
    });
    expect(status).not.toHaveBeenCalled();
    status.mockRestore();
    const full = await client.callTool({
      name: "vectis_operation",
      arguments: { id: "history-0" },
    });
    expect(full).toMatchObject({
      content: [],
      structuredContent: { result: { result: { largeResult: expect.any(String) } } },
    });
  } finally {
    await client.close();
    await server.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP rejects invalid tool arguments without exposing parser or client errors", async () => {
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new VectisError("service_unavailable", "Service unavailable.", " "))
    .mockRejectedValueOnce(new SyntaxError("Unexpected token in private fixture response"));
  await withClient(createMcpServer(connect), async (client) => {
    expect(
      (await client.listTools()).tools.find(({ name }) => name === "vectis_status")?.outputSchema,
    ).toBeDefined();
    for (const args of [[], null, "private fixture input"]) {
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: "vectis_status", arguments: args },
        },
        CallToolResultSchema,
      );
      expectToolError(result, "invalid_request", /input schema/);
      expect(JSON.stringify(result)).not.toContain("private fixture");
    }
    expectToolError(
      await client.callTool({ name: "vectis_status", arguments: { extra: true } }),
      "invalid_request",
    );
    expect(connect).not.toHaveBeenCalled();
    await expect(
      client.request(
        {
          method: "tools/call",
          params: { arguments: {} },
        },
        CallToolResultSchema,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expectToolError(
      await client.callTool({ name: "vectis_wait", arguments: { id: "operation", timeoutMs: 0 } }),
      "invalid_timeout",
      /timeoutMs/,
    );
    expectToolError(await client.callTool({ name: "vectis_status" }), "service_unavailable");
    const failure = await client.callTool({ name: "vectis_status" });
    expectToolError(failure, "tool_failed");
    expect(JSON.stringify(failure)).not.toContain("private fixture");
  });
});

test("MCP metadata exposes titles and conservative permissions for every tool", async () => {
  const server = createMcpServer(
    () => Promise.reject(new Error("Unexpected connection")),
    () => Promise.reject(new Error("Unexpected login service lookup")),
    { home: "/unused", credentials: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
    undefined,
    async () => [],
  );
  await withClient(server, async (client) => {
    const { tools } = await client.listTools();
    const mutating = new Map([
      ["vectis_command", true],
      ["vectis_service", false],
      ["vectis_cloud", false],
    ]);
    expect(
      tools.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name),
    ).toEqual([...mutating.keys()]);
    for (const tool of tools) {
      expect(tool.title).toMatch(/\S/);
      expect(tool.annotations?.title).toEqual(tool.title);
      if (mutating.has(tool.name))
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: mutating.get(tool.name),
        });
      else expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const cloud = tools.find(({ name }) => name === "vectis_cloud");
    expect(cloud?.description?.slice(0, 300)).toMatch(
      /Pair, finish or disconnect.*local session, running service and Keychain helper/,
    );
  });
});

test("MCP local cloud actions distinguish a missing pairing from pending approval", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-pairing-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const stored = new Map<string, string>();
  const credentials = {
    get: async (account: string) => stored.get(account) ?? null,
    set: async (account: string, value: string) => {
      stored.set(account, value);
    },
    remove: async (account: string) => {
      stored.delete(account);
    },
  };
  const cloudUrl = "https://mcp-pairing-fixture.example.com";
  vi.stubEnv("VECTIS_CLOUD_URL", cloudUrl);
  vi.stubEnv("VECTIS_WEB_URL", "https://mcp-fixture.example.com");
  const actualFetch = globalThis.fetch;
  const cloudFetch = vi.fn(async () => Response.json({ state: "pending" }));
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === `${cloudUrl}/machine/pairing`) return cloudFetch();
    if (String(input).startsWith(service.connection.url)) return actualFetch(input, init);
    throw new Error("Unexpected external request");
  });
  try {
    await withClient(
      createMcpServer(async () => api, undefined, { home, credentials }),
      async (client) => {
        await client.listTools();
        expect(await client.callTool({ name: "vectis_status" })).toHaveProperty(
          "structuredContent.result.cloud.state",
          "unconfigured",
        );
        for (const name of [
          "vectis_github_accounts",
          "vectis_repositories",
          "vectis_jobs",
          "vectis_job_logs",
        ]) {
          const args =
            name === "vectis_jobs"
              ? { bindingId: "binding" }
              : name === "vectis_job_logs"
                ? { bindingId: "binding", jobId: 1 }
                : {};
          expectToolError(
            await client.callTool({ name, arguments: args }),
            "not_paired",
            /vectis cloud pair/,
          );
        }
        const cloud = (action: string) =>
          client.callTool({ name: "vectis_cloud", arguments: { action } });
        expectToolError(await cloud("finish"), "not_paired", /vectis cloud pair/);
        expectToolError(await cloud("disconnect"), "not_paired");
        expect(cloudFetch).not.toHaveBeenCalled();
        expect(await cloud("pair")).toHaveProperty(
          "structuredContent.result.state",
          "action_required",
        );
        expect(await cloud("finish")).toHaveProperty("structuredContent.result.state", "pending");
        expect(cloudFetch).toHaveBeenCalledTimes(1);
      },
    );
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP preserves a configured but unavailable local relay and remote pairing errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-relay-"));
  await writeFile(join(home, "cloud.json"), "malformed fixture");
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  try {
    await withClient(
      createMcpServer(async () => api),
      async (client) => {
        expect(await client.callTool({ name: "vectis_status" })).toHaveProperty(
          "structuredContent.result.cloud.state",
          "unavailable",
        );
        expectToolError(
          await client.callTool({ name: "vectis_github_accounts" }),
          "cloud_unavailable",
        );
      },
    );
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
  }

  const remoteHome = await mkdtemp(join(tmpdir(), "vectis-mcp-remote-relay-"));
  const get = vi.fn().mockResolvedValue("fixture-secret");
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  const server = createMcpServer(
    async () => new RemoteClient(await controllerClient(remoteHome, { get }), "remote-fixture"),
    undefined,
    undefined,
    "remote-fixture",
  );
  try {
    await withClient(server, async (client) => {
      const accounts = () => client.callTool({ name: "vectis_github_accounts" });
      expectToolError(await accounts(), "not_signed_in");
      expect(get).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      await writeFile(
        join(remoteHome, "controller.json"),
        JSON.stringify({
          deploymentUrl: "https://isolated-test.example.com",
          controllerId: "controller",
          expiresAt: Date.now() + 60000,
        }),
      );
      for (const code of ["cloud_unconfigured", "cloud_unavailable", "machine_revoked"]) {
        fetcher.mockResolvedValueOnce(Response.json({ queryId: "query" }));
        fetcher.mockResolvedValueOnce(
          Response.json({
            pending: false,
            responseJson: JSON.stringify({
              ok: false,
              code,
              message: "Fixture failure.",
              nextStep: "Check the selected machine.",
            }),
          }),
        );
        expectToolError(await accounts(), code === "cloud_unconfigured" ? "not_paired" : code);
      }
      expect(fetcher).toHaveBeenCalledTimes(6);
    });
  } finally {
    vi.unstubAllGlobals();
    await rm(remoteHome, { recursive: true, force: true });
  }
});

test("MCP status is stable for reordered snapshots and reports newest entries first", async () => {
  const api = new VectisClient({ url: "http://127.0.0.1:1", token: "synthetic" });
  const snapshot: Snapshot = {
    protocolVersion: 1,
    machine: { id: "local", name: "Mac", paused: false },
    cloud: { state: "removed" },
    environments: ["b", "a"].map((id) => ({
      id,
      name: id,
      os: "linux",
      state: "ready",
      cpu: 2,
      memoryMiB: 512,
      basePath: "/fixture",
    })),
    instances: ["b", "a"].map((id) => ({
      id,
      environmentId: id,
      status: "running",
      pid: 1,
      createdAt: "2026-01-01",
    })),
    operations: ["b", "a", "c"].map((id) => ({
      id,
      key: id,
      command: "fixture",
      status: id === "a" ? "failed" : "succeeded",
      createdAt: "2026-01-01",
      updatedAt: id === "c" ? "2026-01-02" : "2026-01-01",
      message: "Fixture",
    })),
    activities: [],
  };
  vi.spyOn(api, "status")
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({
      ...snapshot,
      environments: snapshot.environments.toReversed(),
      instances: snapshot.instances.toReversed(),
      operations: snapshot.operations.toReversed(),
    });
  await withClient(
    createMcpServer(async () => api),
    async (client) => {
      await client.listTools();
      const call = () => client.callTool({ name: "vectis_status" });
      const first = await call();
      expectTextResult(first);
      expect(first.structuredContent).toMatchObject({
        result: {
          cloud: { state: "removed" },
          environments: [{ id: "a" }, { id: "b" }],
          instances: [{ id: "a" }, { id: "b" }],
          operations: [{ id: "c" }, { id: "a" }, { id: "b" }],
          activities: [],
        },
      });
      expect(await call()).toEqual(first);
    },
  );
});
