import { Schema } from "effect";

export const protocolVersion = 1;
export const Identifier = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),
);
export const GuestOS = Schema.Literals(["linux", "macos", "windows"]);
export const Environment = Schema.Struct({
  id: Identifier,
  name: Schema.NonEmptyString,
  os: GuestOS,
  basePath: Schema.NonEmptyString,
  storagePath: Schema.optional(Schema.NonEmptyString),
  cpu: Schema.Int,
  memoryMiB: Schema.Int,
  state: Schema.Literals(["ready", "action_required"]),
  sshHost: Schema.optional(Schema.String),
  sshPort: Schema.optional(Schema.Int),
  sshUser: Schema.optional(Schema.String),
  sshKeyPath: Schema.optional(Schema.String),
  knownHostsPath: Schema.optional(Schema.String),
  seedPath: Schema.optional(Schema.String),
  firmwarePath: Schema.optional(Schema.String),
  firmwareVarsPath: Schema.optional(Schema.String),
  tpmStatePath: Schema.optional(Schema.String),
});
export type Environment = typeof Environment.Type;
export const Operation = Schema.Struct({
  id: Identifier,
  key: Schema.NonEmptyString,
  command: Schema.String,
  status: Schema.Literals([
    "accepted",
    "running",
    "action_required",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  message: Schema.String,
  result: Schema.optional(Schema.Unknown),
});
export type Operation = typeof Operation.Type;
export const Machine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  paused: Schema.Boolean,
});
export const Instance = Schema.Struct({
  id: Identifier,
  environmentId: Identifier,
  directory: Schema.optional(Schema.String),
  cpu: Schema.optional(Schema.Int),
  memoryMiB: Schema.optional(Schema.Int),
  status: Schema.Literals(["running", "stopped", "interrupted"]),
  pid: Schema.Int,
  macAddress: Schema.optional(Schema.String),
  sshHost: Schema.optional(Schema.String),
  sshPort: Schema.optional(Schema.Int),
  createdAt: Schema.String,
});
export type Instance = typeof Instance.Type;
export const CloudStatus = Schema.Struct({
  state: Schema.Literals(["unconfigured", "connecting", "connected", "unavailable"]),
  message: Schema.optional(Schema.String),
});
export type CloudStatus = typeof CloudStatus.Type;
export const Snapshot = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  machine: Machine,
  environments: Schema.Array(Environment),
  instances: Schema.Array(Instance),
  operations: Schema.Array(Operation),
  cloud: Schema.optional(CloudStatus),
});
export type Snapshot = typeof Snapshot.Type;
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("runner.run"), bindingId: Identifier }),
  Schema.Struct({ type: Schema.Literal("operation.cancel"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("machine.pause"), paused: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("environment.register"), environment: Environment }),
  Schema.Struct({ type: Schema.Literal("environment.remove"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("environment.configure"),
    id: Identifier,
    cpu: Schema.optional(Schema.Int),
    memoryMiB: Schema.optional(Schema.Int),
    storagePath: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("environment.start"),
    id: Identifier,
    cpu: Schema.optional(Schema.Int),
    memoryMiB: Schema.optional(Schema.Int),
    storagePath: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({ type: Schema.Literal("instance.stop"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("instance.reconcile"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("migration.preview"),
    source: Schema.String,
    targets: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  }),
]);
export type Command = typeof Command.Type;
export const Request = Schema.Struct({ key: Schema.NonEmptyString, command: Command });
export const ApiError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  nextStep: Schema.String,
});
export type ApiError = typeof ApiError.Type;
export const Connection = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Int,
});
export type Connection = typeof Connection.Type;
export const capabilities = [
  {
    name: "runner.run",
    description:
      "Run one disposable repository runner; job results remain authoritative on GitHub.",
  },
  {
    name: "operation.cancel",
    description: "Request cancellation of an active runner and wait for its cleanup status.",
  },
  {
    name: "repository.list",
    description: "List currently authorized repositories for this cloud-connected machine.",
  },
  {
    name: "doctor",
    description: "Inspect the running service runtime configuration and host prerequisites.",
  },
  {
    name: "storage",
    description: "Inspect base and VM file sizes, allocated blocks and host file breakdown.",
  },
  { name: "status", description: "Read machine, environments, instances, and recent operations." },
  {
    name: "machine.pause",
    description: "Pause or resume accepting new instances without stopping running work.",
  },
  {
    name: "environment.register",
    description: "Register an existing prepared guest disk or macOS bundle.",
  },
  {
    name: "environment.remove",
    description: "Remove an idle environment definition; never delete the source disk.",
  },
  {
    name: "environment.configure",
    description: "Set CPU, memory or an absolute VM storage directory for future instances.",
  },
  {
    name: "environment.start",
    description:
      "Start a disposable VM with optional CPU, memory and storage overrides for this instance.",
  },
  {
    name: "instance.reconcile",
    description: "Reconcile an interrupted instance only after verified process exit.",
  },
  { name: "instance.stop", description: "Stop an instance owned by this service." },
  {
    name: "migration.preview",
    description: "Preview conservative changes to an Actions workflow without writing files.",
  },
] as const;
export class VectisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStep = "Run vectis doctor for diagnostics.",
  ) {
    super(message);
  }
}
export function decodeCommand(input: unknown): Command {
  try {
    return Schema.decodeUnknownSync(Command, { onExcessProperty: "error" })(input);
  } catch {
    throw new VectisError(
      "invalid_request",
      "The command does not match the protocol.",
      "Run vectis capabilities and inspect the command schema.",
    );
  }
}
