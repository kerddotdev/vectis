import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { installation, verifiedUser } from "./githubValidators.js";

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
    verifiedAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_machine", ["machineId"])
    .index("by_target", ["machineId", "repositoryId", "environmentId"]),
  machines: defineTable({
    owner: v.string(),
    localId: v.string(),
    name: v.string(),
    revoked: v.boolean(),
    credentialVersion: v.optional(v.number()),
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_owner", ["owner"])
    .index("by_owner_local", ["owner", "localId"]),
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
