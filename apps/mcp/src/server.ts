import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";
import {
  Request,
  Identifier,
  capabilities,
  VectisError,
} from "../../../packages/protocol/src/index.js";
import type { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import type { VectisClient } from "../../../packages/client/src/index.js";

const commandSchema = Schema.toJsonSchemaDocument(Request);
const waitInput = Schema.Struct({ id: Identifier, timeoutMs: Schema.optional(Schema.Int) });
const waitSchema = Schema.toJsonSchemaDocument(waitInput);
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
const tools = [
  {
    name: "vectis_storage",
    description:
      "Inspect VM disk capacity, allocated host blocks and per-file usage. Guest filesystem breakdown is reported separately as unavailable until connected.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_status",
    description:
      "Read the real local machine, environments, instances and operations. Requires a running Vectis service.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_capabilities",
    description:
      "Discover supported Vectis commands and their versioned schema before making changes.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_command",
    description:
      "Submit a Vectis command. Supply a stable key for safe retries. Returns an accepted operation, not a completion guarantee. Use vectis_wait to observe its outcome.",
    inputSchema: { ...commandSchema.schema, $defs: commandSchema.definitions },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "vectis_wait",
    description:
      "Wait for an operation for up to 120000 ms. Cancelling the wait does not cancel the operation.",
    inputSchema: { ...waitSchema.schema, $defs: waitSchema.definitions },
    annotations: { readOnlyHint: true },
  },
].map((tool) => ToolSchema.parse(tool));

const serviceInput = Schema.Struct({
  action: Schema.Literals(["install", "start", "stop", "status", "uninstall"]),
});
const serviceSchema = Schema.toJsonSchemaDocument(serviceInput);

export function createMcpServer(
  connect: () => Promise<VectisClient>,
  loginService?: () => Promise<LaunchAgent>,
) {
  const availableTools = loginService
    ? [
        ...tools,
        ToolSchema.parse({
          name: "vectis_service",
          description:
            "Manage the local macOS login service: install, start an installed service, stop owned VMs and the service, inspect registration, or uninstall after stopping. Preserves data. Install requires a built checkout and uses the MCP process runtime paths. This tool works without an API connection except for stop.",
          inputSchema: { ...serviceSchema.schema, $defs: serviceSchema.definitions },
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ]
    : tools;
  const server = new Server(
    { name: "vectis", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Start with vectis_capabilities and vectis_status. Only advertised commands are supported. Reuse an idempotency key only for the same command. Inspect failed and action_required outcomes; never report an accepted operation as completed.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: availableTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    try {
      let result: unknown;
      switch (request.params.name) {
        case "vectis_service": {
          if (!loginService)
            throw new VectisError(
              "unsupported_tool",
              "Login service management is unavailable in this MCP session.",
            );
          const input = Schema.decodeUnknownSync(serviceInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result =
            input.action === "stop"
              ? await (await connect()).shutdown()
              : await (await loginService())[input.action]();
          break;
        }
        case "vectis_storage":
          result = await (await connect()).storage();
          break;
        case "vectis_status":
          result = await (await connect()).status();
          break;
        case "vectis_capabilities":
          result = { protocolVersion: 1, capabilities, requestSchema: commandSchema };
          break;
        case "vectis_command": {
          const input = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result = await (await connect()).submit(input.command, input.key);
          break;
        }
        case "vectis_wait": {
          const input = Schema.decodeUnknownSync(waitInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          const timeout = input.timeoutMs ?? 30000;
          if (timeout < 1 || timeout > 120000)
            throw new VectisError("invalid_timeout", "Timeout must be between 1 and 120000 ms.");
          result = await (
            await connect()
          ).wait(input.id, AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]));
          break;
        }
        default:
          throw new VectisError(
            "unknown_tool",
            "Unknown Vectis tool.",
            "List tools and call vectis_capabilities.",
          );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    } catch (error) {
      const issue =
        error instanceof VectisError
          ? error
          : new VectisError(
              "invalid_request",
              "The tool request could not be completed.",
              "Check the tool schema and local service status.",
            );
      const result = { code: issue.code, message: issue.message, nextStep: issue.nextStep };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { error: result },
      };
    }
  });
  return server;
}
