import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createMcpServer } from "./server.js";
import { startService } from "../../server/src/http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { VectisError } from "../../../packages/protocol/src/index.js";

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
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("vectis_command");
    const args = { key: "mcp-pause", command: { type: "machine.pause", paused: true } };
    const accepted = await client.callTool({ name: "vectis_command", arguments: args });
    expect(accepted.isError).not.toBe(true);
    await service.service.drain();
    const retried = await client.callTool({ name: "vectis_command", arguments: args });
    expect(retried).toMatchObject({
      structuredContent: { result: { key: "mcp-pause", status: "succeeded" } },
    });
    expect((await api.status()).operations).toHaveLength(1);
    expect(await client.callTool({ name: "vectis_doctor", arguments: {} })).toMatchObject({
      structuredContent: { result: { source: "service" } },
    });
    expect(await client.callTool({ name: "vectis_repositories", arguments: {} })).toMatchObject({
      isError: true,
    });
    const status = await client.callTool({ name: "vectis_status", arguments: {} });
    expect(status).toMatchObject({ structuredContent: { result: { machine: { paused: true } } } });
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
