import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
