-- Column names mirror the protocol field names. Timestamps are milliseconds since the epoch,
-- booleans are 0 or 1, and nested values are JSON text in *Json columns.

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  localId TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  environmentsJson TEXT,
  paused INTEGER,
  UNIQUE (owner, localId)
);

CREATE TABLE machineCredentials (
  machineId TEXT PRIMARY KEY REFERENCES machines (id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE pairings (
  requestDigest TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX pairings_owner ON pairings (owner);
CREATE INDEX pairings_expiry ON pairings (expiresAt);

CREATE TABLE controllers (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  requestDigest TEXT NOT NULL UNIQUE,
  credentialDigest TEXT NOT NULL,
  pairingExpiresAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX controllers_owner ON controllers (owner, revoked);
CREATE INDEX controllers_expiry ON controllers (expiresAt);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  commandJson TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN ('accepted', 'claimed', 'running', 'action_required', 'succeeded', 'failed', 'cancelled')
  ),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  resultJson TEXT,
  cancelRequested INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, key)
);
CREATE INDEX operations_machine_phase ON operations (machineId, phase, createdAt);
CREATE INDEX operations_accepted ON operations (createdAt) WHERE phase = 'accepted';
CREATE INDEX operations_updated ON operations (updatedAt);

CREATE TABLE inspections (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  queryJson TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  responseJson TEXT,
  pending INTEGER NOT NULL,
  UNIQUE (owner, key)
);
CREATE INDEX inspections_machine_pending ON inspections (machineId, pending, expiresAt);
CREATE INDEX inspections_expiry ON inspections (expiresAt);

CREATE TABLE githubApps (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  appId INTEGER NOT NULL,
  slug TEXT NOT NULL,
  ownerId INTEGER NOT NULL,
  clientId TEXT NOT NULL,
  privateKey TEXT NOT NULL,
  clientSecret TEXT NOT NULL,
  webhookSecret TEXT NOT NULL
);

CREATE TABLE githubAppSetups (
  stateDigest TEXT PRIMARY KEY,
  ownerId INTEGER NOT NULL,
  ownerLogin TEXT NOT NULL,
  organization INTEGER,
  expiresAt INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE githubLinks (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  verifier TEXT,
  browserDigest TEXT,
  completionDigest TEXT,
  expiresAt INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending', 'exchanging', 'review', 'failed')),
  userJson TEXT
);
CREATE INDEX githubLinks_owner ON githubLinks (owner);
CREATE INDEX githubLinks_expiry ON githubLinks (expiresAt);

CREATE TABLE githubAccounts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  githubId INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  installationsJson TEXT NOT NULL,
  verifiedAt INTEGER NOT NULL
);
CREATE INDEX githubAccounts_owner ON githubAccounts (owner);

CREATE TABLE repositoryBindings (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  accountId TEXT NOT NULL REFERENCES githubAccounts (id) ON DELETE CASCADE,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  repositoryId INTEGER NOT NULL,
  repositoryName TEXT NOT NULL,
  repositoryOwner TEXT,
  installationId INTEGER NOT NULL,
  environmentId TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  infraRerun INTEGER NOT NULL DEFAULT 0,
  automatic INTEGER NOT NULL DEFAULT 0,
  capacityMode TEXT NOT NULL DEFAULT 'demand' CHECK (capacityMode IN ('demand', 'scale_set')),
  accessJson TEXT,
  cacheVolumeJson TEXT,
  verifiedAt INTEGER NOT NULL,
  UNIQUE (machineId, repositoryId, environmentId)
);
CREATE INDEX repositoryBindings_owner ON repositoryBindings (owner);
CREATE INDEX repositoryBindings_repository
  ON repositoryBindings (installationId, repositoryId, enabled, automatic);

-- Scale sets outlive their binding and machine: deleting either leaves the row in phase
-- 'deleting' so the cron can remove the remote set. No foreign keys on purpose.
CREATE TABLE runnerScaleSets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  installationId INTEGER NOT NULL,
  repositoryId INTEGER NOT NULL,
  bindingId TEXT NOT NULL,
  machineId TEXT NOT NULL,
  repositoryOwner TEXT NOT NULL,
  repositoryName TEXT NOT NULL,
  githubUserId INTEGER NOT NULL,
  githubLogin TEXT NOT NULL,
  scaleSetId INTEGER,
  name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sessionId TEXT,
  phase TEXT NOT NULL CHECK (
    phase IN ('opening', 'active', 'refreshing', 'closing', 'closed', 'action_required', 'deleting')
  ),
  cleanupDueAt INTEGER,
  cleanupAttempt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  UNIQUE (bindingId, machineId)
);
CREATE INDEX runnerScaleSets_cleanup ON runnerScaleSets (cleanupDueAt) WHERE phase = 'deleting';

CREATE TABLE runnerLeases (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  bindingId TEXT NOT NULL REFERENCES repositoryBindings (id) ON DELETE CASCADE,
  environmentId TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('linux', 'macos', 'windows')),
  key TEXT NOT NULL,
  environmentRevision TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'ready', 'action_required', 'released')),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  runnerId INTEGER,
  encodedConfig TEXT,
  cacheWrite INTEGER,
  cacheWriteReason TEXT,
  cacheRunJson TEXT,
  configExpiresAt INTEGER,
  accessJson TEXT,
  scaleSetGeneration INTEGER,
  jobId INTEGER,
  automatic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (machineId, key)
);
CREATE INDEX runnerLeases_machine_phase ON runnerLeases (machineId, phase);
CREATE INDEX runnerLeases_config_expiry ON runnerLeases (configExpiresAt)
  WHERE configExpiresAt IS NOT NULL;
CREATE INDEX runnerLeases_updated ON runnerLeases (updatedAt);

-- The primary key makes a job claimable by one demand row; see runners/demand.ts.
CREATE TABLE runnerDemands (
  installationId INTEGER NOT NULL,
  repositoryId INTEGER NOT NULL,
  jobId INTEGER NOT NULL,
  owner TEXT NOT NULL,
  bindingId TEXT NOT NULL REFERENCES repositoryBindings (id) ON DELETE CASCADE,
  operationId TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (installationId, repositoryId, jobId)
);
CREATE INDEX runnerDemands_binding ON runnerDemands (bindingId);

CREATE TABLE githubJobs (
  installationId INTEGER NOT NULL,
  repositoryId INTEGER NOT NULL,
  jobId INTEGER NOT NULL,
  runId INTEGER NOT NULL,
  runAttempt INTEGER,
  actorId INTEGER,
  triggeringActorId INTEGER,
  name TEXT NOT NULL,
  htmlUrl TEXT,
  workflowName TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'queued', 'in_progress', 'completed')),
  conclusion TEXT,
  labelsJson TEXT NOT NULL,
  runnerId INTEGER,
  runnerName TEXT,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (installationId, repositoryId, jobId)
);
CREATE INDEX githubJobs_repository ON githubJobs (installationId, repositoryId, status, updatedAt);
CREATE INDEX githubJobs_recent ON githubJobs (installationId, repositoryId, updatedAt);
CREATE INDEX githubJobs_runner ON githubJobs (installationId, repositoryId, runnerName)
  WHERE runnerName IS NOT NULL;
CREATE INDEX githubJobs_queued ON githubJobs (installationId, repositoryId)
  WHERE status = 'queued';
CREATE INDEX githubJobs_updated ON githubJobs (updatedAt);

CREATE TABLE githubDeliveries (
  deliveryId TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  repositoryId INTEGER,
  installationId INTEGER,
  jobId INTEGER,
  receivedAt INTEGER NOT NULL
);
CREATE INDEX githubDeliveries_received ON githubDeliveries (receivedAt);

CREATE TABLE githubRedeliveryCheckpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  deliveredAt INTEGER NOT NULL,
  scannedAt INTEGER NOT NULL
);

CREATE TABLE githubRedeliveryRequests (
  guid TEXT PRIMARY KEY,
  requestedAt INTEGER NOT NULL
);
CREATE INDEX githubRedeliveryRequests_requested ON githubRedeliveryRequests (requestedAt);

-- Receipts prevent duplicate GitHub POSTs within the 30-day retention window.
CREATE TABLE runCommandReceipts (
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  bindingId TEXT NOT NULL,
  requestHash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'accepted', 'uncertain', 'rejected')),
  outcomeJson TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (machineId, key)
);
CREATE INDEX runCommandReceipts_updated ON runCommandReceipts (updatedAt);

CREATE TABLE migrationPreviews (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  machineId TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  bindingId TEXT NOT NULL REFERENCES repositoryBindings (id) ON DELETE CASCADE,
  reportJson TEXT NOT NULL,
  environmentRevision TEXT,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX migrationPreviews_machine ON migrationPreviews (machineId);
CREATE INDEX migrationPreviews_expiry ON migrationPreviews (expiresAt);
