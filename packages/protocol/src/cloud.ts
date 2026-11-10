import { Schema } from "effect";
import { Identifier } from "./identifier.js";
import { GuestOS } from "./index.js";
import { RepositoryReadinessInput, CloudRepositoryReadiness } from "./readiness.js";
import { MachineRepositories, GitHubAccounts } from "./repositories.js";
import { Job, Jobs, JobObservations, JobScan, JobLogs } from "./jobs.js";
import { RunnerGrant, RunnerLease, RunnerStatus } from "./runners.js";
import { ScaleSetGrant } from "./scale-sets.js";
import { RunControlCommand, RunControlOutcome } from "./runs.js";
import { MigrationAnalysis, MigrationPublication } from "./migrations.js";
import { RepositoryAccess, GitHubId } from "./repository-access.js";
import { CacheSizeGiB, CacheVolume } from "./cache-volume.js";

export { CloudUrl } from "./cloud-url.js";

// Every error response is this body with a 4xx or 5xx status. 401 with machine_unauthorized or
// machine_revoked means the machine credential no longer exists; any 5xx means unavailable.
export const CloudErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
});
export type CloudErrorBody = typeof CloudErrorBody.Type;

export const OperationPhase = Schema.Literals([
  "accepted",
  "claimed",
  "running",
  "action_required",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OperationPhase = typeof OperationPhase.Type;

export const EnvironmentSummary = Schema.Struct({
  id: Identifier,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  os: GuestOS,
  cpu: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })),
  memoryMiB: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16777216 })),
  state: Schema.Literals(["ready", "action_required"]),
  revision: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type EnvironmentSummary = typeof EnvironmentSummary.Type;

const Slots = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 }));
export const EnvironmentSlots = Schema.Array(
  Schema.Struct({ environmentId: Identifier, available: Slots }),
).check(Schema.isMaxLength(100));

// --- Machine socket -----------------------------------------------------------------------------
//
// GET /machine/socket upgrades with Sec-WebSocket-Protocol "vectis.v1, auth.<base64url(id.secret)>"
// and the server answers "vectis.v1". The client sends the text "ping" every 30 seconds; the
// runtime answers "pong" without waking the hub. Every other frame is JSON.

export const machineSocketProtocol = "vectis.v1";
export const socketCloseCodes = { stale: 4000, removed: 4001, replaced: 4002 } as const;

// Sent on connect and whenever any field changes. The hub answers status.ack with the same seq once
// the status is stored, or status.rejected when it is invalid.
export const MachineStatus = Schema.Struct({
  t: Schema.Literal("status"),
  seq: Schema.Int,
  paused: Schema.Boolean,
  runnerIdle: Schema.Boolean,
  runnerSlots: Schema.optional(Slots),
  environmentSlots: Schema.optional(EnvironmentSlots),
  environments: Schema.Array(EnvironmentSummary).check(Schema.isMaxLength(100)),
});
export type MachineStatus = typeof MachineStatus.Type;
export const ClientSocketMessage = MachineStatus;

// changed is a hint to POST /machine/sync. It carries no data; the snapshot is the truth.
export const ServerSocketMessage = Schema.Union([
  Schema.Struct({ t: Schema.Literal("status.ack"), seq: Schema.Int }),
  Schema.Struct({ t: Schema.Literal("status.rejected"), seq: Schema.Int, code: Schema.String }),
  Schema.Struct({ t: Schema.Literal("changed") }),
]);
export type ServerSocketMessage = typeof ServerSocketMessage.Type;

// --- Machine HTTP API ---------------------------------------------------------------------------
//
// Every route is POST <path> with a JSON body and `Authorization: Bearer <machineId>.<secret>`.
// Success is 200 with the response body.

export const RemoteOperation = Schema.Struct({
  id: Identifier,
  phase: OperationPhase,
  commandJson: Schema.String,
  cancelRequested: Schema.Boolean,
  createdAt: Schema.Number,
});
export type RemoteOperation = typeof RemoteOperation.Type;

export const PendingInspection = Schema.Struct({ id: Identifier, queryJson: Schema.String });

// The newest job update time of a binding's repository, or null without jobs. A changed marker
// means `jobs/list` would return something new.
export const JobMarker = Schema.NullOr(Schema.Number);

export const SyncSnapshot = Schema.Struct({
  operations: Schema.Array(RemoteOperation),
  inspections: Schema.Array(PendingInspection),
  repositories: MachineRepositories,
  jobMarkers: Schema.Record(Schema.String, JobMarker),
  observations: JobObservations,
});
export type SyncSnapshot = typeof SyncSnapshot.Type;

const BindingId = Identifier;
const BindingRequest = Schema.Struct({ bindingId: BindingId });
const Empty = Schema.Struct({});
const Done = Schema.Null;

export const MachineApi = {
  "/machine/sync": {
    request: Schema.Struct({ leaseIds: Schema.Array(Identifier).check(Schema.isMaxLength(20)) }),
    response: SyncSnapshot,
  },
  "/machine/operations/acknowledge": {
    request: Schema.Struct({
      id: Identifier,
      phase: OperationPhase,
      resultJson: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
    }),
    response: Done,
  },
  "/machine/inspections/respond": {
    request: Schema.Struct({ id: Identifier, responseJson: Schema.String }),
    response: Done,
  },
  "/machine/github/accounts": { request: Empty, response: GitHubAccounts },
  "/machine/repositories/connect": {
    request: Schema.Struct({
      accountId: Identifier,
      environmentId: Identifier,
      repositoryName: Schema.NonEmptyString,
      repositoryOwner: Schema.optional(Schema.String),
    }),
    response: Schema.Struct({ bindingId: BindingId }),
  },
  "/machine/repositories/disconnect": { request: BindingRequest, response: Done },
  "/machine/repositories/readiness": {
    request: Schema.Struct({ input: RepositoryReadinessInput }),
    response: CloudRepositoryReadiness,
  },
  "/machine/repositories/set-automatic": {
    request: Schema.Struct({ bindingId: BindingId, enabled: Schema.Boolean }),
    response: Done,
  },
  "/machine/repositories/set-infra-rerun": {
    request: Schema.Struct({ bindingId: BindingId, enabled: Schema.Boolean }),
    response: Done,
  },
  "/machine/repositories/set-capacity-mode": {
    request: Schema.Struct({
      bindingId: BindingId,
      capacityMode: Schema.Literals(["demand", "scale_set"]),
    }),
    response: Done,
  },
  "/machine/repositories/set-cache-volume": {
    request: Schema.Struct({
      bindingId: BindingId,
      enabled: Schema.Boolean,
      sizeGiB: Schema.optional(CacheSizeGiB),
    }),
    response: Done,
  },
  "/machine/repositories/set-access": {
    request: Schema.Struct({ bindingId: BindingId, ...RepositoryAccess.fields }),
    response: Done,
  },
  "/machine/jobs/list": { request: BindingRequest, response: Jobs },
  "/machine/jobs/scan": { request: BindingRequest, response: JobScan },
  "/machine/jobs/refresh": {
    request: Schema.Struct({ bindingId: BindingId, jobId: GitHubId }),
    response: Job,
  },
  "/machine/jobs/logs": {
    request: Schema.Struct({
      bindingId: BindingId,
      jobId: GitHubId,
      after: Schema.optional(Schema.Int),
    }),
    response: JobLogs,
  },
  "/machine/runners/reconcile": {
    request: Schema.Struct({ bindingId: BindingId, environmentId: Identifier, key: Schema.String }),
    response: RunnerLease,
  },
  "/machine/runners/prepare": {
    request: Schema.Struct({
      bindingId: BindingId,
      key: Schema.String,
      jobId: Schema.optional(GitHubId),
      automatic: Schema.optional(Schema.Boolean),
      scaleSet: Schema.optional(Schema.Struct({ generation: Schema.Int })),
    }),
    response: RunnerGrant,
  },
  "/machine/runners/status": {
    request: Schema.Struct({ id: Identifier }),
    response: RunnerStatus,
  },
  "/machine/runners/release": {
    request: Schema.Struct({ id: Identifier }),
    response: Schema.Struct({ state: Schema.Literal("released"), id: Identifier }),
  },
  "/machine/scale-sets/open": { request: BindingRequest, response: ScaleSetGrant },
  "/machine/scale-sets/refresh": {
    request: Schema.Struct({ bindingId: BindingId, generation: Schema.Int }),
    response: ScaleSetGrant,
  },
  "/machine/scale-sets/close": {
    request: Schema.Struct({ bindingId: BindingId, generation: Schema.Int }),
    response: Done,
  },
  "/machine/runs/control": {
    request: Schema.Struct({ key: Schema.String, command: RunControlCommand }),
    response: RunControlOutcome,
  },
  "/machine/migrations/analyze": { request: BindingRequest, response: MigrationAnalysis },
  "/machine/migrations/publish": {
    request: Schema.Struct({ previewId: Identifier }),
    response: MigrationPublication,
  },
} as const;
export type MachineApi = typeof MachineApi;
export type MachinePath = keyof MachineApi;
export type MachineRequest<P extends MachinePath> = MachineApi[P]["request"]["Type"];
export type MachineResponse<P extends MachinePath> = MachineApi[P]["response"]["Type"];

// --- Human HTTP API -----------------------------------------------------------------------------
//
// Called by the browser with `Authorization: Bearer <Clerk session token>`. CORS allows only the
// configured web origin. GET /account/overview has no body; every other route is POST with JSON.

const Installation = Schema.Struct({ id: Schema.Int, accountId: Schema.Int, login: Schema.String });
export const GitHubUser = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  installations: Schema.Array(Installation),
});

export const AccountMachine = Schema.Struct({
  id: Identifier,
  localId: Identifier,
  name: Schema.String,
  createdAt: Schema.Number,
  environments: Schema.Array(EnvironmentSummary),
  paused: Schema.Boolean,
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.Number),
  runnerIdle: Schema.optional(Schema.Boolean),
  runnerSlots: Schema.optional(Schema.Int),
});
export const AccountBinding = Schema.Struct({
  id: Identifier,
  accountId: Identifier,
  machineId: Identifier,
  repositoryId: Schema.Int,
  repositoryName: Schema.String,
  repositoryOwner: Schema.optional(Schema.String),
  installationId: Schema.Int,
  environmentId: Identifier,
  enabled: Schema.Boolean,
  infraRerun: Schema.Boolean,
  automatic: Schema.Boolean,
  capacityMode: Schema.Literals(["demand", "scale_set"]),
  access: Schema.optional(RepositoryAccess),
  cacheVolume: Schema.optional(CacheVolume),
  verifiedAt: Schema.Number,
  runsOn: Schema.String,
});
export const AccountOverview = Schema.Struct({
  machines: Schema.Array(AccountMachine),
  github: Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        id: Identifier,
        githubId: Schema.Int,
        login: Schema.String,
        installations: Schema.Array(Installation),
        verifiedAt: Schema.Number,
      }),
    ),
    pending: Schema.Array(
      Schema.Struct({
        id: Identifier,
        phase: Schema.Literals(["pending", "exchanging", "review", "failed"]),
        user: Schema.optional(GitHubUser),
      }),
    ),
  }),
  bindings: Schema.Array(AccountBinding),
  controllers: Schema.Array(
    Schema.Struct({
      id: Identifier,
      name: Schema.String,
      createdAt: Schema.Number,
      expiresAt: Schema.Number,
    }),
  ),
  installation: Schema.NullOr(Schema.Struct({ url: Schema.String })),
});
export type AccountOverview = typeof AccountOverview.Type;

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ById = Schema.Struct({ id: Identifier });

export const HumanApi = {
  "/account/remove": { request: Empty, response: Done },
  "/pairings/approve": {
    request: Schema.Struct({
      requestDigest: Digest,
      credentialDigest: Digest,
      localId: Identifier,
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      expiresAt: Schema.Number,
    }),
    response: Schema.Struct({ machineId: Identifier }),
  },
  "/controllers/approve": {
    request: Schema.Struct({
      requestDigest: Digest,
      credentialDigest: Digest,
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      expiresAt: Schema.Number,
    }),
    response: Schema.Struct({ controllerId: Identifier }),
  },
  "/controllers/revoke": { request: ById, response: Done },
  "/machines/remove": { request: ById, response: Done },
  "/github/accounts/unlink": { request: ById, response: Done },
  "/github/links/discard": { request: ById, response: Done },
  "/repositories/enable": {
    request: Schema.Struct({
      accountId: Identifier,
      machineId: Identifier,
      repositoryName: Schema.NonEmptyString,
      repositoryOwner: Schema.optional(Schema.String),
      environmentId: Identifier,
    }),
    response: Schema.Struct({ bindingId: Identifier }),
  },
  "/repositories/disable": { request: ById, response: Done },
} as const;
export type HumanApi = typeof HumanApi;
export type HumanPath = keyof HumanApi;
export type HumanRequest<P extends HumanPath> = HumanApi[P]["request"]["Type"];
export type HumanResponse<P extends HumanPath> = HumanApi[P]["response"]["Type"];

// --- Controller API -----------------------------------------------------------------------------
//
// POST /controller/request with `Authorization: Bearer <controllerId>.<secret>` and a
// ControllerRequest body (controller.ts). Errors are CloudErrorBody with 401 for an invalid
// controller and 409 for every refused request. Responses by request type:

export const ControllerOperation = Schema.Struct({
  id: Identifier,
  machineId: Identifier,
  key: Schema.String,
  commandJson: Schema.String,
  phase: OperationPhase,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  resultJson: Schema.optional(Schema.String),
});
export const ControllerMachine = Schema.Struct({
  id: Identifier,
  localId: Identifier,
  name: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.Number),
  online: Schema.Boolean,
  environments: Schema.Array(EnvironmentSummary),
  paused: Schema.Boolean,
});
export const ControllerResponses = {
  "operation.cancel": Schema.Struct({ operationId: Identifier }),
  "query.submit": Schema.Struct({ queryId: Identifier }),
  "query.get": Schema.Struct({
    pending: Schema.Boolean,
    responseJson: Schema.NullOr(Schema.String),
  }),
  "controller.revoke": Schema.Struct({ revoked: Schema.Literal(true) }),
  "machines.list": Schema.Array(ControllerMachine),
  "operation.submit": Schema.Struct({ operationId: Identifier }),
  "operation.get": ControllerOperation,
} as const;
export type ControllerResponses = typeof ControllerResponses;

// POST /controller/pairing and POST /machine/pairing take `{ secret }` (43 base64url characters)
// and answer `{ state: "pending" }` until the request is approved.
export const PairingSecret = Schema.Struct({
  secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
const Pending = Schema.Struct({ state: Schema.Literal("pending") });
export const MachinePairingResult = Schema.Union([
  Pending,
  Schema.Struct({ machineId: Identifier, localId: Identifier }),
]);
export const ControllerPairingResult = Schema.Union([
  Pending,
  Schema.Struct({ controllerId: Identifier, expiresAt: Schema.Number }),
]);
