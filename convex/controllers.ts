import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server.js";
import { human } from "./auth.js";
import { submitForOwner } from "./operations.js";
import { ControllerRequest } from "../packages/protocol/src/controller.js";

export const approve = mutation({
  args: {
    requestDigest: v.string(),
    credentialDigest: v.string(),
    name: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const now = Date.now();
    if (
      !/^[a-f0-9]{64}$/.test(args.requestDigest) ||
      !/^[a-f0-9]{64}$/.test(args.credentialDigest) ||
      !args.name.trim() ||
      args.name.length > 100 ||
      !Number.isFinite(args.expiresAt) ||
      args.expiresAt <= now ||
      args.expiresAt > now + 600000
    )
      throw new ConvexError({ code: "invalid_controller_request" });
    const previous = await ctx.db
      .query("controllers")
      .withIndex("by_request", (q) => q.eq("requestDigest", args.requestDigest))
      .unique();
    if (previous) {
      if (
        previous.owner !== owner ||
        previous.revoked ||
        previous.name !== args.name ||
        previous.credentialDigest !== args.credentialDigest ||
        previous.pairingExpiresAt !== args.expiresAt
      )
        throw new ConvexError({ code: "controller_conflict" });
      return previous._id;
    }
    const active = await ctx.db
      .query("controllers")
      .withIndex("by_owner_active", (q) => q.eq("owner", owner).eq("revoked", false))
      .take(21);
    for (const record of active)
      if (record.expiresAt <= now) await ctx.db.patch("controllers", record._id, { revoked: true });
    if (active.filter((record) => record.expiresAt > now).length >= 20)
      throw new ConvexError({
        code: "controller_limit",
        nextStep: "Revoke an unused CLI or desktop connection.",
      });
    return ctx.db.insert("controllers", {
      owner,
      name: args.name,
      requestDigest: args.requestDigest,
      credentialDigest: args.credentialDigest,
      pairingExpiresAt: args.expiresAt,
      expiresAt: now + 90 * 86400000,
      revoked: false,
      createdAt: now,
    });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await human(ctx);
    const records = await ctx.db
      .query("controllers")
      .withIndex("by_owner_active", (q) => q.eq("owner", owner).eq("revoked", false))
      .take(21);
    return records.map(({ _id, name, createdAt, expiresAt }) => ({
      id: _id,
      name,
      createdAt,
      expiresAt,
    }));
  },
});
export const revoke = mutation({
  args: { id: v.id("controllers") },
  handler: async (ctx, args) => {
    const owner = await human(ctx);
    const record = await ctx.db.get("controllers", args.id);
    if (!record || record.owner !== owner) throw new ConvexError({ code: "controller_missing" });
    await ctx.db.patch("controllers", args.id, { revoked: true });
  },
});
export const resolve = internalQuery({
  args: { requestDigest: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("controllers")
      .withIndex("by_request", (q) => q.eq("requestDigest", args.requestDigest))
      .unique();
    if (
      !record ||
      record.revoked ||
      record.pairingExpiresAt <= Date.now() ||
      record.expiresAt <= Date.now()
    )
      return null;
    return { controllerId: record._id, expiresAt: record.expiresAt };
  },
});
export const execute = internalMutation({
  args: { controllerId: v.string(), digest: v.string(), requestJson: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("controllers", args.controllerId);
    const credential = id ? await ctx.db.get("controllers", id) : null;
    if (
      !credential ||
      credential.revoked ||
      credential.expiresAt <= Date.now() ||
      credential.credentialDigest !== args.digest
    )
      throw new ConvexError({
        code: "controller_unauthorized",
        nextStep: "Sign in again with vectis login.",
      });
    if (args.requestJson.length > 65536) throw new ConvexError({ code: "invalid_request" });
    const request = Schema.decodeUnknownSync(ControllerRequest, { onExcessProperty: "error" })(
      JSON.parse(args.requestJson),
    );
    const owner = credential.owner;
    switch (request.type) {
      case "controller.revoke":
        await ctx.db.patch("controllers", credential._id, { revoked: true });
        return { revoked: true };
      case "machines.list": {
        const machines = await ctx.db
          .query("machines")
          .withIndex("by_owner", (q) => q.eq("owner", owner))
          .take(100);
        return machines.map(
          ({ _id, localId, name, revoked, lastSeenAt, environments, paused }) => ({
            id: _id,
            localId,
            name,
            revoked,
            lastSeenAt: lastSeenAt ?? null,
            online: !revoked && lastSeenAt !== undefined && Date.now() - lastSeenAt < 90000,
            environments: environments ?? [],
            paused: paused ?? false,
          }),
        );
      }
      case "operation.submit": {
        const machineId = ctx.db.normalizeId("machines", request.machineId);
        if (!machineId) throw new ConvexError({ code: "machine_unavailable" });
        const operationId = await submitForOwner(ctx, owner, {
          machineId,
          key: request.key,
          commandJson: JSON.stringify(request.command),
        });
        return { operationId };
      }
      case "operation.get": {
        const operationId = ctx.db.normalizeId("operations", request.id);
        const operation = operationId ? await ctx.db.get("operations", operationId) : null;
        if (!operation || operation.owner !== owner)
          throw new ConvexError({ code: "operation_missing" });
        return operation;
      }
    }
  },
});
