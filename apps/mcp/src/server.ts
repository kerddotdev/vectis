import { RepositoryReadinessInput } from "../../../packages/protocol/src/readiness.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestParamsSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
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
import { JobLogRequest, Jobs } from "../../../packages/protocol/src/jobs.js";
import { LogRequest } from "../../../packages/protocol/src/logs.js";
import { redact } from "../../../packages/client/src/redact.js";
import { byId, compactStatus, MachineList, outputSchema, StatusResult } from "./results.js";

const commandSchema = Schema.toJsonSchemaDocument(Request);
const waitTimeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120000 }));
const waitInput = Schema.Struct({ id: Identifier, timeoutMs: Schema.optional(Schema.Int) });
const waitSchema = Schema.toJsonSchemaDocument(
  Schema.Struct({ ...waitInput.fields, timeoutMs: Schema.optional(waitTimeout) }),
);
const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const callParams = CallToolRequestParamsSchema.omit({ arguments: true });
const toolArguments = CallToolRequestParamsSchema.shape.arguments.unwrap();

function invalidArguments() {
  return new VectisError(
    "invalid_request",
    "The tool arguments do not match its input schema.",
    "List tools and retry with arguments that match the tool's input schema.",
  );
}

function decodeInput<S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input);
  if (decoded._tag === "Some") return decoded.value;
  throw invalidArguments();
}

async function withMachinePairing<A>(read: () => Promise<A>): Promise<A> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof VectisError && error.code === "cloud_unconfigured")
      throw new VectisError(
        "not_paired",
        "The target machine is not paired with Vectis.",
        "On the target machine, run vectis cloud pair, approve the request in your browser, then run vectis cloud finish.",
      );
    throw error;
  }
}
const jobInput = Schema.Struct({ bindingId: Identifier });
const readinessSchema = Schema.toJsonSchemaDocument(RepositoryReadinessInput);
const jobLogSchema = Schema.toJsonSchemaDocument(JobLogRequest);
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
    title: "List GitHub Accounts",
    description:
      "List verified GitHub identities for the target machine's owner. Requires machine cloud pairing and an active cloud connection. Use an account ID with repository.connect.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_jobs",
    title: "List GitHub Jobs",
    description:
      "Read the latest 100 GitHub jobs for a repository binding. Requires a paired machine and access to the binding. GitHub conclusions are separate from local runner lifecycle status.",
    inputSchema: { ...jobSchema.schema, $defs: jobSchema.definitions },
    outputSchema: outputSchema(Jobs),
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_job_logs",
    title: "Read GitHub Job Logs",
    description:
      "Read a GitHub job log by binding ID and job ID. Requires a paired machine with access to the job. Reads UTF-8 chunks from the last 4 MiB. Pass next as after to continue. Poll until complete; running jobs may not have logs yet. truncated means earlier content was skipped. GitHub masking is preserved.",
    inputSchema: { ...jobLogSchema.schema, $defs: jobLogSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_repositories",
    title: "List Connected Repositories",
    description:
      "List connected repositories and their environment IDs. Requires machine cloud pairing and current account authorization.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_readiness",
    title: "Check Repository Readiness",
    description:
      "Check readiness for a repository name or an existing binding ID. Requires access to the target service. Returns each prerequisite with its status, code, next step and symbolic fix target.",
    inputSchema: { type: "object", ...readinessSchema.schema, $defs: readinessSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_doctor",
    title: "Inspect Vectis Diagnostics",
    description:
      "Inspect host prerequisites and runtime configuration. Requires access to a running Vectis service.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_github_connect",
    title: "Get GitHub Connection Link",
    description:
      "Get the browser link for connecting a GitHub identity. Requires a configured Vectis deployment. A human signs in and confirms the identity. This tool works without a running service.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_storage",
    title: "Inspect VM Storage",
    description:
      "Inspect VM disk capacity, allocated host blocks and per-file usage. Requires access to the target service. Guest filesystem usage is unavailable until connected.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_status",
    title: "Read Machine Status",
    description:
      "Read a compact status summary for the target machine. Requires access to the target service. Includes environments, non-stopped instances, counts within the status window and the newest 20 operations and activities. Use vectis_activities, vectis_activity and vectis_operation for details.",
    inputSchema: emptySchema,
    outputSchema: outputSchema(StatusResult),
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_capabilities",
    title: "Discover Vectis Capabilities",
    description:
      "Discover supported commands and their versioned schema. Local discovery works offline; remote discovery requires a remote-control login and a reachable target.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_command",
    title: "Submit Vectis Command",
    description:
      "Submit a command to the target service with a stable idempotency key. Requires access to the service and any prerequisites listed by vectis_capabilities. Use vectis_wait to observe the outcome.",
    inputSchema: { ...commandSchema.schema, $defs: commandSchema.definitions },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "vectis_operation",
    title: "Read Operation",
    description:
      "Read one operation's status, message, next step and result. Requires an operation ID and access to the target service.",
    inputSchema: { ...operationSchema.schema, $defs: operationSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_activities",
    title: "List Activities",
    description:
      "List unfinished activities and recent terminal activities, newest first. Requires access to the target service. Filter by kind, status, repository or limit (default 50). Use vectis_activity to fetch a retained activity by ID.",
    inputSchema: { ...activitiesSchema.schema, $defs: activitiesSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_activity",
    title: "Read Activity",
    description:
      "Read an activity and its operations, oldest first. Requires an activity ID and access to the target service. Use vectis_wait to wait for one of the operations.",
    inputSchema: { ...activitySchema.schema, $defs: activitySchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_logs",
    title: "Read Service Logs",
    description:
      "Read the newest lines of the target service log. Requires access to the target service. Default 200 lines, at most 1000.",
    inputSchema: { ...logSchema.schema, $defs: logSchema.definitions },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vectis_wait",
    title: "Wait for Operation",
    description:
      "Wait for an operation to finish. Requires an operation ID and access to the target service. timeoutMs defaults to 30000 and accepts 1 to 120000. A timeout returns the current operation with timedOut: true. Cancelling a wait leaves the operation running.",
    inputSchema: { ...waitSchema.schema, $defs: waitSchema.definitions },
    annotations: { readOnlyHint: true },
  },
];

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
      | "repositoryReadiness"
      | "githubAccounts"
      | "jobs"
      | "jobLogs"
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
  pairing?: { home: string; credentials: Pick<KeychainCredentials, "get" | "set" | "remove"> },
  machineId?: string,
  machines?: () => Promise<unknown>,
) {
  const availableTools = loginService
    ? [
        ...tools,
        {
          name: "vectis_service",
          title: "Manage Local Service",
          description:
            "Manage the local macOS login service. Starting requires an installed service; stopping requires a running service. Actions are install, start, stop, status, uninstall, update and recoverUpdate. ifIdle applies to stop. Install and update use the MCP runtime paths. Update refuses active work and restores the previous registration if startup fails. Use recoverUpdate after an interrupted update.",
          inputSchema: { ...serviceSchema.schema, $defs: serviceSchema.definitions },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        },
      ]
    : [...tools];
  if (pairing)
    availableTools.push({
      name: "vectis_cloud",
      title: "Manage Machine Pairing",
      description:
        "Pair, finish or disconnect this machine from Vectis Cloud. Requires a local session, running service and Keychain helper. Pair returns a private link and code for the owner to approve in a browser. Finish checks pending approval or verifies a saved connection. Disconnect clears a saved connection and credential when the user asks.",
      inputSchema: { ...cloudSchema.schema, $defs: cloudSchema.definitions },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    });
  if (machines)
    availableTools.push({
      name: "vectis_machines",
      title: "List Account Machines",
      description:
        "List account machines and their presence. Requires a completed vectis login. Use vectis_status in a local MCP session to inspect this machine. Start vectis-mcp with --machine <id> to control one remotely.",
      inputSchema: emptySchema,
      outputSchema: outputSchema(MachineList),
      annotations: { readOnlyHint: true },
    });
  const listedTools = availableTools.map((tool) =>
    ToolSchema.parse({ ...tool, annotations: { ...tool.annotations, title: tool.title } }),
  );
  const server = new Server(
    { name: "vectis", version: buildInfo().version },
    {
      capabilities: { tools: {} },
      instructions:
        "Start with vectis_capabilities and vectis_status. Submit only capabilities of kind command through vectis_command; the rest have their own read tools. Reuse an idempotency key only for the same command. Read what the machine was asked to do with vectis_activities, and one intent with its steps through vectis_activity. Inspect failed and action_required outcomes with vectis_operation and vectis_logs; never report an accepted operation as completed. Run control commands (run.rerun-failed, run.cancel, workflow.dispatch) never repeat a GitHub POST for the same key while its receipt is retained (30 days); do not replay older keys. Successful rerun/cancel results include result.rerun or result.cancellation: requested means GitHub accepted the request, observed means a newer attempt or stopped run was seen. Only ambiguous POST responses leave rerun/cancel run_command_unconfirmed. For run_command_unconfirmed, inspect GitHub before retrying with a new key. Documentation for agents: https://vectis.kerd.dev/llms.txt",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools }));
  // The SDK's tools/call handler rejects non-object arguments before the tool can report them.
  server.fallbackRequestHandler = async (request, context): Promise<CallToolResult> => {
    if (request.method !== "tools/call")
      throw new McpError(ErrorCode.MethodNotFound, "Method not found.");
    const params = callParams.safeParse(request.params);
    if (!params.success || params.data.task)
      throw new McpError(ErrorCode.InvalidParams, "Invalid tools/call parameters.");

    const { name } = params.data;
    try {
      const parsed = toolArguments.safeParse(
        request.params?.arguments === undefined ? {} : request.params.arguments,
      );
      if (!parsed.success) throw invalidArguments();
      const args = parsed.data;
      const tool = listedTools.find((tool) => tool.name === name);
      if (
        tool?.inputSchema.additionalProperties === false &&
        Object.keys(tool.inputSchema.properties ?? {}).length === 0 &&
        Object.keys(args).length > 0
      )
        throw invalidArguments();

      let result: unknown;
      switch (name) {
        case "vectis_github_connect":
          result = githubConnection(cloudDeployment());
          break;
        case "vectis_cloud": {
          if (!pairing)
            throw new VectisError(
              "setup_required",
              "Machine pairing is unavailable in this MCP session.",
              "Use a local MCP session with the Vectis Keychain helper configured.",
            );
          const { action } = decodeInput(cloudInput, args);
          const { home, credentials } = pairing;
          result =
            action === "pair"
              ? await beginPairing(home, cloudDeployment(), credentials)
              : await withMachinePairing(async () =>
                  action === "disconnect"
                    ? disconnectPairing(home, credentials)
                    : finishPairing(
                        home,
                        credentials,
                        AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
                      ),
                );
          break;
        }
        case "vectis_service": {
          if (!loginService)
            throw new VectisError(
              "unsupported_tool",
              "Login service management is unavailable in this MCP session.",
            );
          const input = decodeInput(serviceInput, args);
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
          const input = decodeInput(jobInput, args);
          const client = await connect();
          result = (await withMachinePairing(() => client.jobs(input.bindingId)))
            .toSorted((a, b) => b.updatedAt - a.updatedAt || a.jobId - b.jobId)
            .map((job) => ({ ...job, labels: job.labels.toSorted() }));
          break;
        }
        case "vectis_job_logs": {
          const input = decodeInput(JobLogRequest, args);
          const client = await connect();
          result = await withMachinePairing(() => client.jobLogs(input));
          break;
        }
        case "vectis_github_accounts": {
          const client = await connect();
          result = await withMachinePairing(() => client.githubAccounts());
          break;
        }
        case "vectis_repositories": {
          const client = await connect();
          result = await withMachinePairing(() => client.repositories());
          break;
        }
        case "vectis_readiness": {
          const input = decodeInput(RepositoryReadinessInput, args);
          result = await (await connect()).repositoryReadiness(input);
          break;
        }
        case "vectis_doctor":
          result = await (await connect()).doctor();
          break;
        case "vectis_status":
          result = compactStatus(await (await connect()).status());
          break;
        case "vectis_operation": {
          const input = decodeInput(operationInput, args);
          result = await (await connect()).operation(input.id);
          break;
        }
        case "vectis_activities": {
          const input = decodeInput(activitiesInput, args);
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
          const input = decodeInput(operationInput, args);
          result = await (await connect()).activity(input.id);
          break;
        }
        case "vectis_logs": {
          const input = decodeInput(LogRequest, args);
          result = await (await connect()).logs(input.lines);
          break;
        }
        case "vectis_machines":
          if (!machines)
            throw new VectisError(
              "unsupported_tool",
              "Machine discovery is unavailable in this MCP session.",
              "Use vectis machine list from a Vectis CLI session with a remote-control login.",
            );
          result = Schema.decodeUnknownSync(MachineList)(await machines())
            .toSorted(byId)
            .map((machine) => ({ ...machine, environments: machine.environments.toSorted(byId) }));
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
          const input = decodeInput(Request, args);
          result = await (await connect()).submit(input.command, input.key);
          break;
        }
        case "vectis_wait": {
          const input = decodeInput(waitInput, args);
          const timeout = input.timeoutMs ?? 30000;
          if (!Schema.is(waitTimeout)(timeout))
            throw new VectisError(
              "invalid_timeout",
              "Timeout must be between 1 and 120000 ms.",
              "Retry with timeoutMs between 1 and 120000, or omit it for the default.",
            );
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
      const structuredContent = { result };
      return {
        content: tool?.outputSchema
          ? [{ type: "text", text: JSON.stringify(structuredContent) }]
          : [],
        structuredContent,
      };
    } catch (error) {
      const issue =
        error instanceof VectisError
          ? error
          : new VectisError(
              "tool_failed",
              "The tool request failed while contacting Vectis or reading its response.",
              "Check the Vectis service and selected target with vectis doctor or vectis_status before retrying.",
            );
      const code = redact(issue.code);
      const details = {
        code: /^[a-z][a-z0-9_]*$/.test(code) ? code : "tool_failed",
        message: redact(issue.message).trim() || "The Vectis request could not be completed.",
        nextStep: redact(issue.nextStep).trim() || "Run vectis doctor for diagnostics.",
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(details) }],
        structuredContent: { error: details },
      };
    }
  };
  return server;
}
