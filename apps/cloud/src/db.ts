import type { EnvironmentSummary, OperationPhase } from "../../../packages/protocol/src/cloud.js";
import type {
  RepositoryAccess,
  RunnerAccess,
} from "../../../packages/protocol/src/repository-access.js";
import type { CacheVolume } from "../../../packages/protocol/src/cache-volume.js";

// Raw rows exactly as D1 returns them (see migrations/0001_init.sql). Booleans are 0 or 1 and
// *Json columns are JSON text; the record helpers below decode the ones most modules share.

export type Flag = 0 | 1;

export interface MachineRow {
  id: string;
  owner: string;
  localId: string;
  name: string;
  createdAt: number;
  environmentsJson: string | null;
  paused: Flag | null;
}
export interface OperationRow {
  id: string;
  owner: string;
  machineId: string;
  key: string;
  commandJson: string;
  phase: OperationPhase;
  createdAt: number;
  updatedAt: number;
  resultJson: string | null;
  cancelRequested: Flag;
}
export interface InspectionRow {
  id: string;
  owner: string;
  machineId: string;
  key: string;
  queryJson: string;
  expiresAt: number;
  responseJson: string | null;
  pending: Flag;
}
export interface ControllerRow {
  id: string;
  owner: string;
  name: string;
  requestDigest: string;
  credentialDigest: string;
  pairingExpiresAt: number;
  expiresAt: number;
  revoked: Flag;
  createdAt: number;
}
export interface PairingRow {
  requestDigest: string;
  owner: string;
  machineId: string;
  expiresAt: number;
}
export interface GitHubAppRow {
  singleton: 1;
  appId: number;
  slug: string;
  ownerId: number;
  clientId: string;
  privateKey: string;
  clientSecret: string;
  webhookSecret: string;
}
export interface GitHubAppSetupRow {
  stateDigest: string;
  ownerId: number;
  ownerLogin: string;
  organization: Flag | null;
  expiresAt: number;
  consumed: Flag;
}
export interface GitHubLinkRow {
  id: string;
  owner: string;
  digest: string;
  verifier: string | null;
  browserDigest: string | null;
  completionDigest: string | null;
  expiresAt: number;
  phase: "pending" | "exchanging" | "review" | "failed";
  userJson: string | null;
}
export interface GitHubAccountRow {
  id: string;
  owner: string;
  githubId: number;
  login: string;
  installationsJson: string;
  verifiedAt: number;
}
export interface BindingRow {
  id: string;
  owner: string;
  accountId: string;
  machineId: string;
  repositoryId: number;
  repositoryName: string;
  repositoryOwner: string | null;
  installationId: number;
  environmentId: string;
  enabled: Flag;
  infraRerun: Flag;
  automatic: Flag;
  capacityMode: "demand" | "scale_set";
  accessJson: string | null;
  cacheVolumeJson: string | null;
  verifiedAt: number;
}
export interface ScaleSetRow {
  id: string;
  owner: string;
  installationId: number;
  repositoryId: number;
  bindingId: string;
  machineId: string;
  repositoryOwner: string;
  repositoryName: string;
  githubUserId: number;
  githubLogin: string;
  scaleSetId: number | null;
  name: string;
  generation: number;
  sessionId: string | null;
  phase:
    | "opening"
    | "active"
    | "refreshing"
    | "closing"
    | "closed"
    | "action_required"
    | "deleting";
  cleanupDueAt: number | null;
  cleanupAttempt: number;
  updatedAt: number;
}
export interface LeaseRow {
  id: string;
  owner: string;
  machineId: string;
  bindingId: string;
  environmentId: string;
  os: "linux" | "macos" | "windows";
  key: string;
  environmentRevision: string | null;
  phase: "preparing" | "ready" | "action_required" | "released";
  createdAt: number;
  updatedAt: number;
  runnerId: number | null;
  encodedConfig: string | null;
  cacheWrite: Flag | null;
  cacheWriteReason: string | null;
  cacheRunJson: string | null;
  configExpiresAt: number | null;
  accessJson: string | null;
  scaleSetGeneration: number | null;
  jobId: number | null;
  automatic: Flag;
}
export interface DemandRow {
  installationId: number;
  repositoryId: number;
  jobId: number;
  owner: string;
  bindingId: string;
  operationId: string;
  attempt: number;
  failures: number;
  updatedAt: number;
}
export interface JobRow {
  installationId: number;
  repositoryId: number;
  jobId: number;
  runId: number;
  runAttempt: number | null;
  actorId: number | null;
  triggeringActorId: number | null;
  name: string;
  htmlUrl: string | null;
  workflowName: string | null;
  status: "waiting" | "queued" | "in_progress" | "completed";
  conclusion: string | null;
  labelsJson: string;
  runnerId: number | null;
  runnerName: string | null;
  updatedAt: number;
}
export interface DeliveryRow {
  deliveryId: string;
  event: string;
  action: string | null;
  repositoryId: number | null;
  installationId: number | null;
  jobId: number | null;
  receivedAt: number;
}
export interface RunReceiptRow {
  machineId: string;
  key: string;
  bindingId: string;
  requestHash: string;
  state: "submitted" | "accepted" | "uncertain" | "rejected";
  outcomeJson: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MigrationPreviewRow {
  id: string;
  owner: string;
  machineId: string;
  bindingId: string;
  reportJson: string;
  environmentRevision: string | null;
  createdAt: number;
  expiresAt: number;
}

export const flag = (value: boolean | undefined): Flag => (value ? 1 : 0);

export function parseJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

export type Machine = Omit<MachineRow, "environmentsJson" | "paused"> & {
  environments: EnvironmentSummary[];
  // Undefined until the machine reported its status at least once.
  paused: boolean | undefined;
};
export function machineRecord(row: MachineRow): Machine {
  const { environmentsJson, paused, ...rest } = row;
  return {
    ...rest,
    environments: parseJson<EnvironmentSummary[]>(environmentsJson) ?? [],
    paused: paused === null ? undefined : paused === 1,
  };
}

export type Binding = Omit<
  BindingRow,
  "enabled" | "infraRerun" | "automatic" | "accessJson" | "cacheVolumeJson" | "repositoryOwner"
> & {
  repositoryOwner: string | undefined;
  enabled: boolean;
  infraRerun: boolean;
  automatic: boolean;
  access: RepositoryAccess | undefined;
  cacheVolume: CacheVolume | undefined;
};
export function bindingRecord(row: BindingRow): Binding {
  const { enabled, infraRerun, automatic, accessJson, cacheVolumeJson, repositoryOwner, ...rest } =
    row;
  return {
    ...rest,
    repositoryOwner: repositoryOwner ?? undefined,
    enabled: enabled === 1,
    infraRerun: infraRerun === 1,
    automatic: automatic === 1,
    access: parseJson<RepositoryAccess>(accessJson),
    cacheVolume: parseJson<CacheVolume>(cacheVolumeJson),
  };
}

export type Installation = { id: number; accountId: number; login: string };
export type GitHubAccount = Omit<GitHubAccountRow, "installationsJson"> & {
  installations: Installation[];
};
export function accountRecord(row: GitHubAccountRow): GitHubAccount {
  const { installationsJson, ...rest } = row;
  return { ...rest, installations: parseJson<Installation[]>(installationsJson) ?? [] };
}

export type { RunnerAccess };
