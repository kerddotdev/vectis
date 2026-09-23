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
import {
  beginPairing,
  disconnectPairing,
  finishPairing,
} from "../../../packages/client/src/pairing.js";
import type { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import type { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import type { VectisClient } from "../../../packages/client/src/index.js";
import { buildInfo } from "../../../packages/client/src/build.js";
import { cloudDeployment } from "../../../packages/client/src/deployment.js";
import { LogRequest } from "../../../packages/protocol/src/logs.js";

const commandSchema = Schema.toJsonSchemaDocument(Request);
const waitInput = Schema.Struct({ id: Identifier, timeoutMs: Schema.optional(Schema.Int) });
const waitSchema = Schema.toJsonSchemaDocument(waitInput);
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
const jobInput = Schema.Struct({ bindingId: Identifier });
const jobSchema = Schema.toJsonSchemaDocument(jobInput);
const operationInput = Schema.Struct({ id: Identifier });
const operationSchema = Schema.toJsonSchemaDocument(operationInput);
const activitiesInput = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["vectis", "github"])),
  status: Schema.optional(
    Schema.Literals(["accepted", "running", "action_required", "succeeded", "failed", "cancelled"]),
  ),
  repository: Schema.optional(Schema.NonEmptyString),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
const activitiesSchema = Schema.toJsonSchemaDocument(activitiesInput);
const activitySchema = Schema.toJsonSchemaDocument(operationInput);
const logSchema = Schema.toJsonSchemaDocument(LogRequest);
const tools = [
  {
    name: "vectis_github_accounts",
    description:
      "List verified GitHub identities owned by this paired machine's owner. Use the returned account ID with repository.connect.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
  },
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
      "Read the selected machine, environments, instances and operations. Requires a running Vectis service.",
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
    name: "vectis_operation",
    description:
      "Read one operation's current status, message, next step and result without waiting.",
    inputSchema: { ...operationSchema.schema, $defs: operationSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_activities",
    description:
      "List what this machine was asked to do, newest first. An activity groups the operations of one intent: a guest preparation with its setup steps, or a runner with its VM. Filter by kind, status, repository or limit.",
    inputSchema: { ...activitiesSchema.schema, $defs: activitiesSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_activity",
    description:
      "Read one activity with the operations that belong to it, oldest first. Wait for an outcome with vectis_wait on the operation that matters.",
    inputSchema: { ...activitySchema.schema, $defs: activitySchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_logs",
    description:
      "Read the newest lines of the Vectis service log (default 200, at most 1000) to diagnose failed or stuck operations.",
    inputSchema: { ...logSchema.schema, $defs: logSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_wait",
    description:
      "Wait for an operation to finish, for timeoutMs (default 30000, at most 120000). If time runs out, returns the operation as it is now with timedOut: true; call again to keep waiting. Cancelling the wait does not cancel the operation.",
    inputSchema: { ...waitSchema.schema, $defs: waitSchema.definitions },
    annotations: { readOnlyHint: true },
  },
].map((tool) => ToolSchema.parse(tool));

const serviceInput = Schema.Struct({
  action: Schema.Literals([
    "install",
    "start",
    "stop",
    "status",
    "uninstall",
    "update",
    "recoverUpdate",
  ]),
  ifIdle: Schema.optional(Schema.Boolean),
});
const cloudInput = Schema.Struct({ action: Schema.Literals(["pair", "finish", "disconnect"]) });
const cloudSchema = Schema.toJsonSchemaDocument(cloudInput);
const serviceSchema = Schema.toJsonSchemaDocument(serviceInput);

export function createMcpServer(
  connect: () => Promise<
    Pick<
      VectisClient,
      | "status"
      | "storage"
      | "doctor"
      | "repositories"
      | "githubAccounts"
      | "jobs"
      | "submit"
      | "wait"
      | "shutdown"
      | "capabilities"
      | "operation"
      | "activities"
      | "activity"
      | "logs"
    >
  >,
  loginService?: () => Promise<LaunchAgent>,
  pairing?: { home: string; credentials: KeychainCredentials },
  machineId?: string,
  machines?: () => Promise<unknown>,
) {
  const availableTools = loginService
    ? [
        ...tools,
        ToolSchema.parse({
          name: "vectis_service",
          description:
            "Manage the local macOS login service: install, start an installed service, stop owned VMs and the service, inspect registration, or uninstall after stopping. Preserves data. Install and update use the MCP process runtime paths. Update refuses active work and restores the previous registration if startup fails. Use recoverUpdate after an interrupted update. This tool works without an API connection except for stop.",
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
          "Pair this local machine with its owner's Vectis account. The pair action returns a private approval link and verification code for the human; never approve it automatically or share it. After human approval, finish persists the credential in Keychain and reloads the relay without stopping VMs. The disconnect action removes the saved connection and its credential from this machine; only run it when the user asks. Requires a running local service.",
        inputSchema: { ...cloudSchema.schema, $defs: cloudSchema.definitions },
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    );
  if (machines)
    availableTools.push(
      ToolSchema.parse({
        name: "vectis_machines",
        description:
          "List the machines owned by the signed-in account, with last-seen presence. Start vectis-mcp with --machine <id> to control one remotely.",
        inputSchema: emptyInput,
        annotations: { readOnlyHint: true },
      }),
    );
  const server = new Server(
    { name: "vectis", version: buildInfo().version },
    {
      capabilities: { tools: {} },
      instructions:
        "Start with vectis_capabilities and vectis_status. Submit only capabilities of kind command through vectis_command; the rest have their own read tools. Reuse an idempotency key only for the same command. Read what the machine was asked to do with vectis_activities, and one intent with its steps through vectis_activity. Inspect failed and action_required outcomes with vectis_operation and vectis_logs; never report an accepted operation as completed. Documentation for agents: https://vectis.kerd.dev/llms.txt",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: availableTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    try {
      let result: unknown;
      switch (request.params.name) {
        case "vectis_github_connect":
          result = githubConnection(cloudDeployment());
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
              ? await beginPairing(pairing.home, cloudDeployment(), pairing.credentials)
              : input.action === "finish"
                ? await finishPairing(
                    pairing.home,
                    pairing.credentials,
                    AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
                  )
                : await disconnectPairing(pairing.home, pairing.credentials);
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
              ? await (await connect()).shutdown({ ifIdle: input.ifIdle ?? false })
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
        case "vectis_github_accounts":
          result = await (await connect()).githubAccounts();
          break;
        case "vectis_repositories":
          result = await (await connect()).repositories();
          break;
        case "vectis_doctor":
          result = await (await connect()).doctor();
          break;
        case "vectis_status":
          result = await (await connect()).status();
          break;
        case "vectis_operation": {
          const input = Schema.decodeUnknownSync(operationInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result = await (await connect()).operation(input.id);
          break;
        }
        case "vectis_activities": {
          const input = Schema.decodeUnknownSync(activitiesInput, { onExcessProperty: "error" })(
            request.params.arguments ?? {},
          );
          result = (await (await connect()).activities())
            .filter((activity) => !input.kind || activity.kind === input.kind)
            .filter((activity) => !input.status || activity.status === input.status)
            .filter(
              (activity) => !input.repository || activity.repository?.name === input.repository,
            )
            .slice(0, input.limit ?? 50);
          break;
        }
        case "vectis_activity": {
          const input = Schema.decodeUnknownSync(operationInput, { onExcessProperty: "error" })(
            request.params.arguments,
          );
          result = await (await connect()).activity(input.id);
          break;
        }
        case "vectis_logs": {
          const input = Schema.decodeUnknownSync(LogRequest, { onExcessProperty: "error" })(
            request.params.arguments ?? {},
          );
          result = await (await connect()).logs(input.lines);
          break;
        }
        case "vectis_machines":
          if (!machines)
            throw new VectisError(
              "setup_required",
              "Listing machines requires a remote control login.",
              "Run vectis login and vectis login finish.",
            );
          result = await machines();
          break;
        case "vectis_capabilities":
          result = {
            protocolVersion: 1,
            capabilities,
            requestSchema: commandSchema,
            target: machineId
              ? { type: "remote", machineId, capabilities: await (await connect()).capabilities() }
              : { type: "local" },
          };
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
          const client = await connect();
          try {
            result = await client.wait(
              input.id,
              AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]),
            );
          } catch (error) {
            if (
              context.signal.aborted ||
              !(error instanceof VectisError && error.code === "wait_cancelled")
            )
              throw error;
            result = { ...(await client.operation(input.id)), timedOut: true };
          }
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
