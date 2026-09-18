import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { installation, verifiedUser } from "./githubValidators.js";

export const environmentSummary = v.object({
  id: v.string(),
  name: v.string(),
  os: v.union(v.literal("linux"), v.literal("macos"), v.literal("windows")),
  cpu: v.number(),
  memoryMiB: v.number(),
  state: v.union(v.literal("ready"), v.literal("action_required")),
});
export const phase = v.union(
  v.literal("accepted"),
  v.literal("claimed"),
  v.literal("running"),
  v.literal("action_required"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);
export default defineSchema({
  githubLinks: defineTable({
    owner: v.string(),
    digest: v.string(),
    verifier: v.optional(v.string()),
    expiresAt: v.number(),
    phase: v.union(
      v.literal("pending"),
      v.literal("exchanging"),
      v.literal("review"),
      v.literal("failed"),
    ),
    user: v.optional(verifiedUser),
  })
    .index("by_owner", ["owner"])
    .index("by_digest", ["digest"]),
  githubAccounts: defineTable({
    owner: v.string(),
    githubId: v.number(),
    login: v.string(),
    installations: v.array(installation),
    verifiedAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_github", ["githubId"]),
  repositoryBindings: defineTable({
    owner: v.string(),
    accountId: v.id("githubAccounts"),
    machineId: v.id("machines"),
    repositoryId: v.number(),
    repositoryName: v.string(),
    installationId: v.number(),
    environmentId: v.string(),
    enabled: v.boolean(),
    automatic: v.optional(v.boolean()),
    verifiedAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_machine", ["machineId"])
    .index("by_target", ["machineId", "repositoryId", "environmentId"]),
  runnerLeases: defineTable({
    owner: v.string(),
    machineId: v.id("machines"),
    bindingId: v.id("repositoryBindings"),
    environmentId: v.string(),
    os: v.union(v.literal("linux"), v.literal("macos"), v.literal("windows")),
    key: v.string(),
    phase: v.union(
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("action_required"),
      v.literal("released"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    runnerId: v.optional(v.number()),
    encodedConfig: v.optional(v.string()),
    configExpiresAt: v.optional(v.number()),
  })
    .index("by_machine_key", ["machineId", "key"])
    .index("by_machine_phase", ["machineId", "phase"]),
  machines: defineTable({
    owner: v.string(),
    localId: v.string(),
    name: v.string(),
    revoked: v.boolean(),
    credentialVersion: v.optional(v.number()),
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    environments: v.optional(v.array(environmentSummary)),
    paused: v.optional(v.boolean()),
    runnerIdle: v.optional(v.boolean()),
  })
    .index("by_owner", ["owner"])
    .index("by_owner_local", ["owner", "localId"]),
  runnerDemands: defineTable({
    installationId: v.number(),
    repositoryId: v.number(),
    jobId: v.number(),
    owner: v.string(),
    bindingId: v.id("repositoryBindings"),
    operationId: v.id("operations"),
    attempt: v.number(),
    updatedAt: v.number(),
  }).index("by_job", ["installationId", "repositoryId", "jobId"]),
  githubJobs: defineTable({
    installationId: v.number(),
    repositoryId: v.number(),
    jobId: v.number(),
    runId: v.number(),
    name: v.string(),
    status: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
    conclusion: v.union(v.string(), v.null()),
    labels: v.array(v.string()),
    runnerId: v.union(v.number(), v.null()),
    runnerName: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_job", ["installationId", "repositoryId", "jobId"])
    .index("by_repository", ["installationId", "repositoryId", "updatedAt"])
    .index("by_repository_status", ["installationId", "repositoryId", "status", "updatedAt"]),
  githubDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    action: v.optional(v.string()),
    repositoryId: v.optional(v.number()),
    installationId: v.optional(v.number()),
    jobId: v.optional(v.number()),
    receivedAt: v.number(),
  }).index("by_delivery", ["deliveryId"]),
  githubAppSetups: defineTable({
    stateDigest: v.string(),
    ownerId: v.number(),
    ownerLogin: v.string(),
    expiresAt: v.number(),
    consumed: v.boolean(),
  }).index("by_state", ["stateDigest"]),
  githubApps: defineTable({
    appId: v.number(),
    slug: v.string(),
    ownerId: v.number(),
    clientId: v.string(),
    privateKey: v.string(),
    clientSecret: v.string(),
    webhookSecret: v.string(),
  }).index("by_app", ["appId"]),
  pairings: defineTable({
    owner: v.string(),
    requestDigest: v.string(),
    machineId: v.id("machines"),
    credentialVersion: v.number(),
    expiresAt: v.number(),
  })
    .index("by_request", ["requestDigest"])
    .index("by_owner", ["owner"])
    .index("by_expiry", ["expiresAt"]),
  machineCredentials: defineTable({
    machineId: v.id("machines"),
    digest: v.string(),
    createdAt: v.number(),
  }).index("by_machine", ["machineId"]),
  operations: defineTable({
    owner: v.string(),
    machineId: v.id("machines"),
    key: v.string(),
    commandJson: v.string(),
    phase,
    createdAt: v.number(),
    updatedAt: v.number(),
    resultJson: v.optional(v.string()),
  })
    .index("by_owner_key", ["owner", "key"])
    .index("by_machine_phase", ["machineId", "phase"]),
});
