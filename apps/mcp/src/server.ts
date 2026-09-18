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
import { githubConnection } from "../../../packages/client/src/github.js";
import { beginPairing, finishPairing } from "../../../packages/client/src/pairing.js";
import type { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import type { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import type { VectisClient } from "../../../packages/client/src/index.js";

const commandSchema = Schema.toJsonSchemaDocument(Request);
const waitInput = Schema.Struct({ id: Identifier, timeoutMs: Schema.optional(Schema.Int) });
const waitSchema = Schema.toJsonSchemaDocument(waitInput);
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
const jobInput = Schema.Struct({ bindingId: Identifier });
const jobSchema = Schema.toJsonSchemaDocument(jobInput);
const tools = [
  {
    name: "vectis_jobs",
    description:
      "Read the latest 100 GitHub job records for a connected repository binding. GitHub conclusions are separate from local runner lifecycle status.",
    inputSchema: { ...jobSchema.schema, $defs: jobSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_repositories",
    description:
      "List repositories connected to this machine and their environment IDs. Requires cloud pairing and current account authorization.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_doctor",
    description:
      "Inspect host prerequisites and the running service runtime configuration. Requires a running service.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_github_connect",
    description:
      "Get the guided GitHub connection URL. A human signs in and confirms the selected GitHub identity in the browser. This tool does not grant repository access or start jobs and requires no running service.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
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
const cloudInput = Schema.Struct({
  action: Schema.Literals(["pair", "finish"]),
  deploymentUrl: Schema.optional(Schema.String),
});
const cloudSchema = Schema.toJsonSchemaDocument(cloudInput);
const serviceSchema = Schema.toJsonSchemaDocument(serviceInput);

export function createMcpServer(
  connect: () => Promise<VectisClient>,
  loginService?: () => Promise<LaunchAgent>,
  pairing?: { home: string; credentials: KeychainCredentials },
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
    : [...tools];
  if (pairing)
    availableTools.push(
      ToolSchema.parse({
        name: "vectis_cloud",
        description:
          "Pair this local machine with its owner's Vectis account. The pair action returns a private approval link and verification code for the human; never approve it automatically or share it. After human approval, finish persists the credential in Keychain and reloads the relay without stopping VMs. Requires a running local service.",
        inputSchema: { ...cloudSchema.schema, $defs: cloudSchema.definitions },
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    );
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
        case "vectis_github_connect":
          result = githubConnection();
          break;
        case "vectis_cloud": {
          if (!pairing)
            throw new VectisError(
              "setup_required",
              "Configure the Keychain helper before pairing.",
            );
          const input = Schema.decodeUnknownSync(cloudInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result =
            input.action === "pair"
              ? await beginPairing(
                  pairing.home,
                  input.deploymentUrl ?? "https://clear-hare-471.convex.cloud",
                  pairing.credentials,
                )
              : await finishPairing(
                  pairing.home,
                  pairing.credentials,
                  AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
                );
          break;
        }
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
        case "vectis_jobs": {
          const input = Schema.decodeUnknownSync(jobInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result = await (await connect()).jobs(input.bindingId);
          break;
        }
        case "vectis_repositories":
          result = await (await connect()).repositories();
          break;
        case "vectis_doctor":
          result = await (await connect()).doctor();
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
