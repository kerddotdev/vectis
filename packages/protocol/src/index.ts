import { Schema } from "effect";
import { Identifier } from "./identifier.js";
import { MachineRepositories, RepositoryConnection } from "./repositories.js";

export { Identifier } from "./identifier.js";
export { RepositoryConnection } from "./repositories.js";

export const protocolVersion = 1;
export const ShutdownOptions = Schema.Struct({ ifIdle: Schema.optional(Schema.Boolean) });
export type ShutdownOptions = typeof ShutdownOptions.Type;
export const GuestOS = Schema.Literals(["linux", "macos", "windows"]);
export const LinuxPreparation = Schema.Struct({
  id: Identifier,
  name: Schema.NonEmptyString,
  imageDirectory: Schema.NonEmptyString,
  storagePath: Schema.NonEmptyString,
  cpu: Schema.Int,
  memoryMiB: Schema.Int,
  diskGiB: Schema.Int,
});
export type LinuxPreparation = typeof LinuxPreparation.Type;
export const MacInstallation = Schema.Struct({
  ...LinuxPreparation.fields,
  restorePath: Schema.optional(Schema.NonEmptyString),
});
export type MacInstallation = typeof MacInstallation.Type;
export const WindowsInstallation = Schema.Struct({
  ...LinuxPreparation.fields,
  isoPath: Schema.NonEmptyString,
  driversPath: Schema.NonEmptyString,
  firmwarePath: Schema.NonEmptyString,
  firmwareVarsPath: Schema.NonEmptyString,
  imageName: Schema.NonEmptyString,
  acceptLicense: Schema.Boolean,
});
export type WindowsInstallation = typeof WindowsInstallation.Type;
export const Preparation = Schema.Struct({
  id: Identifier,
  configuration: LinuxPreparation,
  phase: Schema.Literals([
    "downloading",
    "extracting",
    "converting",
    "provisioning",
    "booting",
    "prepared",
    "interrupted",
  ]),
});
export type Preparation = typeof Preparation.Type;
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
  state: Schema.Literals(["unconfigured", "connecting", "connected", "unavailable", "removed"]),
  message: Schema.optional(Schema.String),
});
export type CloudStatus = typeof CloudStatus.Type;
export const Snapshot = Schema.Struct({
  revision: Schema.String,
  preparationBusy: Schema.optional(Schema.Boolean),
  protocolVersion: Schema.Literal(1),
  version: Schema.optional(Schema.String),
  machine: Machine,
  environments: Schema.Array(Environment),
  instances: Schema.Array(Instance),
  operations: Schema.Array(Operation),
  cloud: Schema.optional(CloudStatus),
  repositories: Schema.optional(MachineRepositories),
});
export type Snapshot = typeof Snapshot.Type;
export const Command = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("environment.install-windows"),
    ...WindowsInstallation.fields,
  }),
  Schema.Struct({ type: Schema.Literal("environment.resume-windows"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("environment.discard-macos"),
    id: Identifier,
    environmentId: Identifier,
  }),
  Schema.Struct({ type: Schema.Literal("repository.disconnect"), bindingId: Identifier }),
  Schema.Struct({ type: Schema.Literal("environment.install-macos"), ...MacInstallation.fields }),
  Schema.Struct({ type: Schema.Literal("environment.prepare-linux"), ...LinuxPreparation.fields }),
  Schema.Struct({ type: Schema.Literal("environment.resume"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("environment.resume-macos"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("environment.open-macos-setup"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("environment.connect-macos-guest"),
    id: Identifier,
    openTerminal: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("environment.verify-macos-guest"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("environment.finish-macos-setup"), id: Identifier }),
  Schema.Struct({ type: Schema.Literal("migration.analyze"), bindingId: Identifier }),
  Schema.Struct({ type: Schema.Literal("migration.publish"), previewId: Identifier }),
  Schema.Struct({
    type: Schema.Literal("job.scan"),
    bindingId: Identifier,
    automatic: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({ type: Schema.Literal("repository.connect"), ...RepositoryConnection.fields }),
  Schema.Struct({
    type: Schema.Literal("repository.automatic"),
    bindingId: Identifier,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("job.refresh"),
    bindingId: Identifier,
    jobId: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ type: Schema.Literal("runner.reconcile"), id: Identifier }),
  Schema.Struct({
    type: Schema.Literal("runner.run"),
    bindingId: Identifier,
    automatic: Schema.optional(Schema.Literal(true)),
    jobId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
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
    name: "environment.install-windows",
    kind: "command",
    activity: "intent",
    description:
      "Prepare Windows 11 ARM64 from local installation and driver ISOs with explicit license acceptance, private UEFI/TPM state and pinned guest SSH keys. Requires configured QEMU, qemu-img, swtpm and Keychain.",
  },
  {
    name: "environment.resume-windows",
    kind: "command",
    activity: "continuation",
    description:
      "Continue an owned Windows installation after verifying its previous VM stopped. Preserves its disk and setup identity.",
  },
  {
    name: "environment.discard-macos",
    kind: "command",
    activity: "continuation",
    description:
      "Permanently delete the current stopped, unregistered macOS setup attempt. Requires its setup ID and exact environment ID confirmation. Registered images and original IPSW files are preserved.",
  },
  {
    name: "repository.disconnect",
    kind: "command",
    activity: "intent",
    description:
      "Disable a repository connection on this machine. Running jobs can finish and release registrations. Workflows and the GitHub App installation are preserved.",
  },
  {
    name: "environment.open-macos-setup",
    kind: "command",
    activity: "continuation",
    description:
      "Open the owned macOS setup bundle in a local VM console. Cancel the operation to stop it. Guest setup does not imply runner readiness.",
  },
  {
    name: "environment.resume-macos",
    kind: "command",
    activity: "continuation",
    description:
      "Inspect or retry an interrupted owned macOS installation after verifying the prior installer stopped. Completed restores are never repeated.",
  },
  {
    name: "environment.connect-macos-guest",
    kind: "command",
    activity: "continuation",
    description:
      "Prepare dedicated guest SSH enrollment for an open macOS setup. Optional openTerminal asks the host user for their guest password locally; no password is stored or transported.",
  },
  {
    name: "environment.verify-macos-guest",
    kind: "command",
    activity: "continuation",
    description:
      "Verify the open macOS guest through its dedicated SSH identity, including ARM64, time and guest FileVault state.",
  },
  {
    name: "environment.finish-macos-setup",
    kind: "command",
    activity: "continuation",
    description: "Register a verified macOS setup after its guest has stopped.",
  },
  {
    name: "environment.install-macos",
    kind: "command",
    activity: "intent",
    description:
      "Install an Apple macOS 26 IPSW into a new owned bundle. Requires an idle Apple Silicon host. Downloads pinned Apple media unless a local restore image is supplied. Finishes with Setup Assistant action required; does not mark a runner ready.",
  },
  {
    name: "environment.prepare-linux",
    kind: "command",
    activity: "intent",
    description:
      "Download and verify Ubuntu 24.04 ARM64, prepare guest SSH and Docker, and register the environment. Requires an idle Apple Silicon host and the Apple helper.",
  },
  {
    name: "environment.resume",
    kind: "command",
    activity: "continuation",
    description:
      "Resume an interrupted owned image preparation after verifying its prior guest stopped.",
  },
  {
    name: "migration.analyze",
    kind: "command",
    activity: "intent",
    description:
      "Inspect repository workflows at a pinned commit and retain a reviewable migration preview.",
  },
  {
    name: "migration.publish",
    kind: "command",
    activity: "intent",
    description:
      "Create or recover a migration PR from a retained preview after verifying local runner success. Never merges.",
  },
  {
    name: "github.accounts",
    kind: "query",
    description: "List the paired machine owner's verified GitHub identities.",
  },
  {
    name: "repository.connect",
    kind: "command",
    activity: "intent",
    description:
      "Connect a prepared environment to a repository after verifying current GitHub App access.",
  },
  {
    name: "repository.automatic",
    kind: "command",
    activity: "setting",
    description: "Enable or disable future automatic runner admission for a repository binding.",
  },
  {
    name: "job.scan",
    kind: "command",
    activity: "intent",
    description:
      "Discover missing queued and running jobs through the GitHub API, and refresh previously active runs.",
  },
  {
    name: "job.refresh",
    kind: "command",
    activity: "intent",
    description: "Refresh a known GitHub job through an authorized repository API request.",
  },
  {
    name: "job.list",
    kind: "query",
    description: "Read the latest 100 GitHub job records for an authorized repository binding.",
  },
  {
    name: "runner.reconcile",
    kind: "command",
    activity: "continuation",
    description: "Clean an interrupted runner registration after its VM has been verified stopped.",
  },
  {
    name: "runner.run",
    kind: "command",
    activity: "intent",
    description:
      "Run one disposable repository runner; job results remain authoritative on GitHub.",
  },
  {
    name: "operation.cancel",
    kind: "command",
    activity: "setting",
    description:
      "Request cancellation of an active background operation, or close one that waits for a person and has no recovery command of its own; inspect its final cleanup status.",
  },
  {
    name: "repository.list",
    kind: "query",
    description: "List currently authorized repositories for this cloud-connected machine.",
  },
  {
    name: "doctor",
    kind: "query",
    description: "Inspect the running service runtime configuration and host prerequisites.",
  },
  {
    name: "storage",
    kind: "query",
    description: "Inspect base and VM file sizes, allocated blocks and host file breakdown.",
  },
  {
    name: "status",
    kind: "query",
    description: "Read machine, environments, instances, and recent operations.",
  },
  {
    name: "machine.pause",
    kind: "command",
    activity: "setting",
    description: "Pause or resume accepting new instances without stopping running work.",
  },
  {
    name: "environment.register",
    kind: "command",
    activity: "setting",
    description: "Register an existing prepared guest disk or macOS bundle.",
  },
  {
    name: "environment.remove",
    kind: "command",
    activity: "setting",
    description: "Remove an idle environment definition; never delete the source disk.",
  },
  {
    name: "environment.configure",
    kind: "command",
    activity: "setting",
    description: "Set CPU, memory or an absolute VM storage directory for future instances.",
  },
  {
    name: "environment.start",
    kind: "command",
    activity: "intent",
    description:
      "Start a disposable VM with optional CPU, memory and storage overrides for this instance.",
  },
  {
    name: "instance.reconcile",
    kind: "command",
    activity: "setting",
    description: "Reconcile an interrupted instance only after verified process exit.",
  },
  {
    name: "instance.stop",
    kind: "command",
    activity: "setting",
    description: "Stop an instance owned by this service.",
  },
  {
    name: "migration.preview",
    kind: "command",
    activity: "intent",
    description: "Preview conservative changes to an Actions workflow without writing files.",
  },
] as const satisfies ReadonlyArray<
  | {
      name: Command["type"];
      kind: "command";
      activity: "intent" | "continuation" | "setting";
      description: string;
    }
  | { name: string; kind: "query"; description: string }
>;

const commandCapabilities = capabilities.filter((capability) => capability.kind === "command");
export const commandActivity: Record<Command["type"], "intent" | "continuation" | "setting"> =
  Schema.decodeUnknownSync(
    Schema.Record(
      Schema.Literals(commandCapabilities.map((capability) => capability.name)),
      Schema.Literals(["intent", "continuation", "setting"]),
    ),
  )(Object.fromEntries(commandCapabilities.map(({ name, activity }) => [name, activity])));

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
