import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { startService } from "../../server/src/http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { VectisError } from "../../../packages/protocol/src/index.js";
import { activityFor } from "../../server/src/activities.js";
import type { RunnerProgress } from "../../../packages/protocol/src/runners.js";

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
    expect(status.content).toEqual([]);
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

test("vectis_jobs preserves the binding access reason", async () => {
  const api = new VectisClient({ url: "http://127.0.0.1:1", token: "synthetic" });
  const { vi } = await import("vitest");
  vi.spyOn(api, "jobs").mockResolvedValue([
    {
      jobId: 4,
      runId: 5,
      name: "Build",
      status: "queued",
      conclusion: null,
      labels: ["vectis-mac"],
      runnerId: null,
      runnerName: null,
      updatedAt: 1,
      access: "approval_required",
    },
  ]);
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "access-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      await client.callTool({ name: "vectis_jobs", arguments: { bindingId: "binding" } }),
    ).toMatchObject({ structuredContent: { result: [{ access: "approval_required" }] } });
  } finally {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  }
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
    expect(tool?.description).toContain("next back as after");
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

test("MCP status stays compact with thousands of retained results and returns data only once", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-mcp-bounded-"));
  const service = await startService({ home });
  const api = new VectisClient(service.connection);
  const server = createMcpServer(async () => api);
  const client = new Client({ name: "bounded-status-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const command = { type: "job.scan", bindingId: "binding" } as const;
    service.store.db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 2000; index++) {
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
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "vectis_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(result).toMatchObject({
      structuredContent: {
        result: {
          operations: expect.any(Array),
          activities: expect.any(Array),
          counts: { operations: { byStatus: { action_required: 1 } } },
          details: expect.stringContaining("vectis_operation"),
        },
      },
    });
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
