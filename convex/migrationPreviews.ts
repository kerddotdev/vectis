import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { RepositoryMigration } from "../packages/protocol/src/migrations.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { bindingAuthority } from "./runnerLeases.js";
import { machine } from "./auth.js";

export const verified = internalQuery({
  args: { bindingId: v.string() },
  handler: async (ctx, args) => {
    const { target, binding } = await bindingAuthority(ctx, args.bindingId, true);
    const leases = await ctx.db
      .query("runnerLeases")
      .withIndex("by_machine_phase", (q) => q.eq("machineId", target._id).eq("phase", "released"))
      .order("desc")
      .take(100);
    const jobs = await ctx.db
      .query("githubJobs")
      .withIndex("by_repository", (q) =>
        q.eq("installationId", binding.installationId).eq("repositoryId", binding.repositoryId),
      )
      .order("desc")
      .take(100);
    return leases.some(
      (lease) =>
        lease.bindingId === binding._id &&
        lease.owner === target.owner &&
        lease.runnerId !== undefined &&
        jobs.some(
          (job) =>
            job.runnerId === lease.runnerId &&
            job.status === "completed" &&
            job.conclusion === "success",
        ),
    );
  },
});
export const save = internalMutation({
  args: { bindingId: v.string(), reportJson: v.string() },
  handler: async (ctx, args) => {
    const { target, binding } = await bindingAuthority(ctx, args.bindingId, true);
    if (new TextEncoder().encode(args.reportJson).length > 768 * 1024)
      throw new ConvexError({ code: "migration_preview_too_large" });
    const report = Schema.decodeUnknownSync(RepositoryMigration)(JSON.parse(args.reportJson));
    const previews = await ctx.db
      .query("migrationPreviews")
      .withIndex("by_machine", (q) => q.eq("machineId", target._id))
      .take(101);
    for (const preview of previews)
      if (preview.expiresAt < Date.now()) await ctx.db.delete("migrationPreviews", preview._id);
    if (previews.filter((item) => item.expiresAt >= Date.now()).length >= 100)
      throw new ConvexError({ code: "migration_preview_limit" });
    return ctx.db.insert("migrationPreviews", {
      owner: target.owner,
      machineId: target._id,
      bindingId: binding._id,
      reportJson: JSON.stringify(report),
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    });
  },
});
export const owned = internalQuery({
  args: { previewId: v.string() },
  handler: async (ctx, args) => {
    const target = await machine(ctx);
    const id = ctx.db.normalizeId("migrationPreviews", args.previewId);
    const preview = id ? await ctx.db.get("migrationPreviews", id) : null;
    if (
      !preview ||
      preview.owner !== target.owner ||
      preview.machineId !== target._id ||
      preview.expiresAt < Date.now()
    )
      throw new ConvexError({ code: "migration_preview_unavailable" });
    await bindingAuthority(ctx, preview.bindingId, true);
    return preview;
  },
});
