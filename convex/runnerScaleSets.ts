import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { runnerLabels } from "../packages/github/src/runner-labels.js";
import { machine } from "./auth.js";
import { bindingAuthority } from "./runnerLeases.js";
import { assertScaleSetBinding } from "./scaleSetPolicy.js";

// A durable intent serializes session effects, including a retry after an action process dies.
const effectWindow = 120000;
const identity = { id: v.id("runnerScaleSets"), generation: v.number() };

export async function findScaleSet(
  ctx: Pick<QueryCtx, "db">,
  bindingId: Id<"repositoryBindings">,
  machineId: Id<"machines">,
) {
  return ctx.db
    .query("runnerScaleSets")
    .withIndex("by_binding_machine", (q) => q.eq("bindingId", bindingId).eq("machineId", machineId))
    .unique();
}

export async function currentScaleSet(
  ctx: Pick<QueryCtx, "db">,
  binding: Doc<"repositoryBindings">,
  generation: number,
) {
  const row = await findScaleSet(ctx, binding._id, binding.machineId);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !row ||
    row.generation !== generation ||
    row.owner !== binding.owner ||
    row.installationId !== binding.installationId ||
    row.repositoryId !== binding.repositoryId
  )
    throw new ConvexError({ code: "scale_set_superseded" });
  return row;
}

function busy(row: Doc<"runnerScaleSets">) {
  return (
    ["opening", "refreshing", "closing"].includes(row.phase) &&
    row.updatedAt > Date.now() - effectWindow
  );
}

export const authorize = internalQuery({
  args: { bindingId: v.string(), preparing: v.boolean() },
  handler: async (ctx, args) => {
    const authority = await bindingAuthority(ctx, args.bindingId, args.preparing);
    if (args.preparing) assertScaleSetBinding(authority.binding);
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    return {
      ...authority,
      app: { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey },
    };
  },
});

export const begin = internalMutation({
  args: {
    bindingId: v.string(),
    operation: v.union(v.literal("open"), v.literal("refresh"), v.literal("close")),
    generation: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Doc<"runnerScaleSets">> => {
    const { target, binding, account } = await bindingAuthority(
      ctx,
      args.bindingId,
      args.operation === "open",
    );
    const existing = await findScaleSet(ctx, binding._id, target._id);
    if (args.operation !== "open") {
      if (args.generation === undefined) throw new ConvexError({ code: "scale_set_superseded" });
      const row = await currentScaleSet(ctx, binding, args.generation);
      if (row.phase === "deleting") throw new ConvexError({ code: "scale_set_superseded" });
      if (args.operation === "refresh") {
        await bindingAuthority(ctx, args.bindingId, true);
        assertScaleSetBinding(binding);
      }
      if (args.operation === "close" && row.phase === "closed") return row;
      if (busy(row)) throw new ConvexError({ code: "scale_set_pending" });
      if (
        args.operation === "refresh" &&
        (!["active", "action_required"].includes(row.phase) ||
          !row.sessionId ||
          row.scaleSetId === undefined)
      )
        throw new ConvexError({ code: "scale_set_session_missing" });
      const patch = {
        phase: args.operation === "refresh" ? ("refreshing" as const) : ("closing" as const),
        updatedAt: Date.now(),
      };
      await ctx.db.patch("runnerScaleSets", row._id, patch);
      return { ...row, ...patch };
    }
    assertScaleSetBinding(binding);
    if (existing?.phase === "deleting")
      throw new ConvexError({ code: "scale_set_cleanup_pending" });
    if (existing && busy(existing)) throw new ConvexError({ code: "scale_set_pending" });
    if (
      existing?.scaleSetId !== undefined &&
      (existing.installationId !== binding.installationId ||
        existing.repositoryId !== binding.repositoryId ||
        existing.owner !== binding.owner)
    )
      throw new ConvexError({ code: "installation_changed" });
    const record = {
      owner: target.owner,
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      bindingId: binding._id,
      machineId: target._id,
      repositoryOwner: binding.repositoryOwner ?? account.login,
      repositoryName: binding.repositoryName,
      githubUserId: account.githubId,
      githubLogin: account.login,
      name: `vectis-${binding.environmentId}-${target._id.slice(0, 8)}`,
      generation: (existing?.generation ?? 0) + 1,
      phase: "opening" as const,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch("runnerScaleSets", existing._id, record);
      return { ...existing, ...record };
    }
    const id = await ctx.db.insert("runnerScaleSets", record);
    const row = await ctx.db.get("runnerScaleSets", id);
    if (!row) throw new Error("Scale set persistence failed.");
    return row;
  },
});

export const checkpoint = internalMutation({
  args: {
    ...identity,
    scaleSetId: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    phase: v.union(v.literal("opening"), v.literal("active"), v.literal("closed")),
  },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const row = await ctx.db.get("runnerScaleSets", args.id);
    if (
      !row ||
      row.generation !== args.generation ||
      row.machineId !== target._id ||
      row.owner !== target.owner ||
      row.phase === "deleting"
    )
      throw new ConvexError({ code: "scale_set_superseded" });
    const expectedPhase =
      args.phase === "closed"
        ? ["closing"]
        : args.phase === "opening"
          ? ["opening"]
          : ["opening", "refreshing"];
    if (!expectedPhase.includes(row.phase)) throw new ConvexError({ code: "scale_set_superseded" });
    const { binding } = await bindingAuthority(ctx, row.bindingId, args.phase !== "closed");
    if (args.phase !== "closed") assertScaleSetBinding(binding);
    await currentScaleSet(ctx, binding, args.generation);
    await ctx.db.patch("runnerScaleSets", row._id, {
      ...(args.scaleSetId === undefined ? {} : { scaleSetId: args.scaleSetId }),
      ...(args.phase === "opening" && args.sessionId === undefined
        ? {}
        : { sessionId: args.sessionId }),
      phase: args.phase,
      updatedAt: Date.now(),
    });
  },
});

export const failed = internalMutation({
  args: identity,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("runnerScaleSets", args.id);
    if (
      row?.generation === args.generation &&
      ["opening", "refreshing", "closing"].includes(row.phase)
    )
      await ctx.db.patch("runnerScaleSets", row._id, {
        phase: "action_required",
        updatedAt: Date.now(),
      });
  },
});

export async function scheduleScaleSetCleanup(
  ctx: MutationCtx,
  bindingId: Id<"repositoryBindings">,
) {
  const rows = await ctx.db
    .query("runnerScaleSets")
    .withIndex("by_binding_machine", (q) => q.eq("bindingId", bindingId))
    .take(100);
  for (const row of rows) {
    if (row.phase === "deleting") continue;
    const generation = row.generation + 1;
    await ctx.db.patch("runnerScaleSets", row._id, {
      generation,
      phase: "deleting",
      updatedAt: Date.now(),
    });
    // Let an already issued request settle before discovering and deleting its remote effects.
    await ctx.scheduler.runAfter(busy(row) ? effectWindow : 0, internal.githubScaleSets.cleanup, {
      id: row._id,
      generation,
      attempt: 0,
    });
  }
}

export const cleanupAuthority = internalQuery({
  args: identity,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("runnerScaleSets", args.id);
    if (!row || row.generation !== args.generation || row.phase !== "deleting") return null;
    const app = await ctx.db.query("githubApps").first();
    if (!app) throw new ConvexError({ code: "github_app_unavailable" });
    return { row, app: { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey } };
  },
});

export const cleaned = internalMutation({
  args: identity,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("runnerScaleSets", args.id);
    if (!row || row.generation !== args.generation || row.phase !== "deleting") return;
    const binding = await ctx.db.get("repositoryBindings", row.bindingId);
    if (!binding) {
      await ctx.db.delete("runnerScaleSets", row._id);
      return;
    }
    // Keep the generation tombstone across a later switch back to scale set capacity.
    await ctx.db.patch("runnerScaleSets", row._id, {
      phase: "closed",
      scaleSetId: undefined,
      sessionId: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const forJit = internalQuery({
  args: { bindingId: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    const { binding, environment } = await bindingAuthority(ctx, args.bindingId, true);
    assertScaleSetBinding(binding);
    const row = await currentScaleSet(ctx, binding, args.generation);
    if (
      !["active", "refreshing"].includes(row.phase) ||
      !row.sessionId ||
      row.scaleSetId === undefined ||
      !environment
    )
      throw new ConvexError({ code: "scale_set_session_missing" });
    return {
      scaleSetId: row.scaleSetId,
      name: row.name,
      labels: [...runnerLabels(environment.os, environment.id), row.name],
    };
  },
});

export const cleanupFailed = internalMutation({
  args: identity,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("runnerScaleSets", args.id);
    if (row?.generation === args.generation && row.phase === "deleting")
      await ctx.db.patch("runnerScaleSets", row._id, {
        phase: "action_required",
        updatedAt: Date.now(),
      });
  },
});
