"use node";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { ScaleSetGrant } from "../packages/protocol/src/scale-sets.js";
import { GitHubAppClient } from "../packages/github/src/app-client.js";
import { runnerLabels } from "../packages/github/src/runner-labels.js";
import {
  bootstrapAdmin,
  ScaleSetBootstrapHttpError,
  tokenExpiration,
} from "../packages/scaleset/src/bootstrap.js";
import { ScaleSetAdminClient, ScaleSetHttpError } from "../packages/scaleset/src/client.js";
import type { Session } from "../packages/scaleset/src/messages.js";
import { repositoryAccess } from "./githubAccess.js";

type Authority = {
  binding: Doc<"repositoryBindings">;
  account: Doc<"githubAccounts">;
};
type Access = { token: string };

// Admin credentials are short lived and stay inside this action invocation.
async function admin(authority: Authority, access: Access, signal: AbortSignal) {
  const connection = await bootstrapAdmin(
    {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      installationToken: access.token,
    },
    (url, init) => fetch(url, init),
    signal,
  );
  return new ScaleSetAdminClient(connection.serviceUrl, connection.adminToken, (url, init) =>
    fetch(url, init),
  );
}

async function connection(
  ctx: ActionCtx,
  bindingId: string,
  preparing: boolean,
  signal: AbortSignal,
) {
  const authority = await ctx.runQuery(internal.runnerScaleSets.authorize, {
    bindingId,
    preparing,
  });
  const access = await repositoryAccess(new GitHubAppClient(authority.app), {
    owner: authority.binding.repositoryOwner ?? authority.account.login,
    repo: authority.binding.repositoryName,
    repositoryId: authority.binding.repositoryId,
    installationId: authority.binding.installationId,
    githubUserId: authority.account.githubId,
    githubLogin: authority.account.login,
    ...(preparing ? {} : { purpose: "cleanup" as const }),
  });
  return { authority, admin: await admin(authority, access, signal) };
}

function grant(row: Doc<"runnerScaleSets">, scaleSetId: number, session: Session): ScaleSetGrant {
  const exp = tokenExpiration(session.messageQueueAccessToken);
  return {
    bindingId: row.bindingId,
    scaleSetId,
    scaleSetName: row.name,
    generation: row.generation,
    sessionId: session.sessionId,
    messageQueueUrl: session.messageQueueUrl,
    messageQueueAccessToken: session.messageQueueAccessToken,
    ...(exp === null ? {} : { queueTokenExpiresAt: exp * 1000 }),
    statistics: session.statistics,
  };
}

function scaleSetError(error: unknown): never {
  if (error instanceof ConvexError) throw error;
  throw new ConvexError({
    code: "scale_set_unavailable",
    message: "The GitHub scale set service could not complete the request.",
    ...(error instanceof ScaleSetHttpError || error instanceof ScaleSetBootstrapHttpError
      ? { status: error.status }
      : {}),
  });
}

async function ignoreMissing(operation: () => Promise<void>) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof ScaleSetHttpError && error.status === 404)) throw error;
  }
}

function verifyLabels(actual: readonly { name: string }[], labels: readonly string[]) {
  const actualLabels = new Set(actual.map((label) => label.name.toLowerCase()));
  if (
    actualLabels.size !== labels.length ||
    !labels.every((label) => actualLabels.has(label.toLowerCase()))
  )
    throw new ConvexError({
      code: "scale_set_labels_unsupported",
      message: "GitHub did not retain the scale set's custom runner labels.",
      nextStep: "Use demand capacity for this repository.",
    });
}

export const open = action({
  args: { bindingId: v.string() },
  handler: async (ctx, args): Promise<ScaleSetGrant> => {
    const signal = AbortSignal.timeout(90000);
    const row = await ctx.runMutation(internal.runnerScaleSets.begin, {
      ...args,
      operation: "open",
    });
    const identity = { id: row._id, generation: row.generation };
    let created: { admin: ScaleSetAdminClient; scaleSetId: number; sessionId: string } | undefined;
    try {
      const { authority, admin } = await connection(ctx, args.bindingId, true, signal);
      const environment = authority.environment;
      if (!environment) throw new ConvexError({ code: "environment_unavailable" });
      const group = await admin.defaultRunnerGroup(signal);
      const labels = [...runnerLabels(environment.os, environment.id), row.name];
      const found = await admin.findScaleSet(group.id, row.name, signal);
      if (found && row.scaleSetId !== undefined && found.id !== row.scaleSetId)
        throw new ConvexError({ code: "scale_set_identity_conflict" });
      const set = found ?? (await admin.createScaleSet(group.id, row.name, labels, signal));
      await ctx.runMutation(internal.runnerScaleSets.checkpoint, {
        ...identity,
        scaleSetId: set.id,
        phase: "opening",
      });
      const effective = await admin.getScaleSet(set.id, signal);
      if (effective.name !== row.name || effective.runnerGroupId !== group.id)
        throw new ConvexError({ code: "scale_set_identity_conflict" });
      verifyLabels(effective.labels, labels);
      const oldSessionId = row.sessionId;
      if (oldSessionId)
        await ignoreMissing(() => admin.deleteSession(set.id, oldSessionId, signal));
      const session = await admin
        .createSession(set.id, `${row.machineId}:${row.generation}`, signal)
        .catch((error: unknown) => {
          if (error instanceof ScaleSetHttpError && error.status === 409)
            throw new ConvexError({
              code: "scale_set_session_conflict",
              message: "GitHub already has a session whose identity Vectis cannot reconcile.",
              nextStep:
                "Close the other scale set listener or wait for its session to expire, then retry.",
            });
          throw error;
        });
      created = { admin, scaleSetId: set.id, sessionId: session.sessionId };
      await ctx.runMutation(internal.runnerScaleSets.checkpoint, {
        ...identity,
        scaleSetId: set.id,
        sessionId: session.sessionId,
        phase: "active",
      });
      return grant(row, set.id, session);
    } catch (error) {
      if (created) {
        const session = created;
        await ignoreMissing(() =>
          session.admin.deleteSession(session.scaleSetId, session.sessionId),
        ).catch(() => undefined);
      }
      await ctx.runMutation(internal.runnerScaleSets.failed, identity);
      return scaleSetError(error);
    }
  },
});

export const refresh = action({
  args: { bindingId: v.string(), generation: v.number() },
  handler: async (ctx, args): Promise<ScaleSetGrant> => {
    const row = await ctx.runMutation(internal.runnerScaleSets.begin, {
      ...args,
      operation: "refresh",
    });
    const identity = { id: row._id, generation: row.generation };
    try {
      if (row.scaleSetId === undefined || !row.sessionId)
        throw new ConvexError({ code: "scale_set_session_missing" });
      const signal = AbortSignal.timeout(90000);
      const { authority, admin } = await connection(ctx, args.bindingId, true, signal);
      const environment = authority.environment;
      if (!environment) throw new ConvexError({ code: "environment_unavailable" });
      const set = await admin.getScaleSet(row.scaleSetId, signal);
      if (set.name !== row.name) throw new ConvexError({ code: "scale_set_identity_conflict" });
      verifyLabels(set.labels, [...runnerLabels(environment.os, environment.id), row.name]);
      const session = await admin.refreshSession(row.scaleSetId, row.sessionId, signal);
      if (session.sessionId !== row.sessionId)
        throw new ConvexError({ code: "scale_set_identity_conflict" });
      await ctx.runMutation(internal.runnerScaleSets.checkpoint, {
        ...identity,
        sessionId: row.sessionId,
        phase: "active",
      });
      return grant(row, row.scaleSetId, session);
    } catch (error) {
      await ctx.runMutation(internal.runnerScaleSets.failed, identity);
      return scaleSetError(error);
    }
  },
});

export const close = action({
  args: { bindingId: v.string(), generation: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runMutation(internal.runnerScaleSets.begin, {
      ...args,
      operation: "close",
    });
    if (row.phase === "closed") return null;
    const identity = { id: row._id, generation: row.generation };
    try {
      const { scaleSetId, sessionId } = row;
      if (scaleSetId !== undefined && sessionId) {
        const signal = AbortSignal.timeout(90000);
        const { admin } = await connection(ctx, args.bindingId, false, signal);
        await ignoreMissing(() => admin.deleteSession(scaleSetId, sessionId, signal));
      }
      await ctx.runMutation(internal.runnerScaleSets.checkpoint, { ...identity, phase: "closed" });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.runnerScaleSets.failed, identity);
      return scaleSetError(error);
    }
  },
});

export async function generateScaleSetJit(
  ctx: ActionCtx,
  input: { bindingId: string; generation: number; runnerName: string },
  authority: Authority,
  access: Access,
) {
  const row = await ctx.runQuery(internal.runnerScaleSets.forJit, {
    bindingId: input.bindingId,
    generation: input.generation,
  });
  const signal = AbortSignal.timeout(90000);
  const client = await admin(authority, access, signal);
  const set = await client.getScaleSet(row.scaleSetId, signal);
  if (set.name !== row.name) throw new ConvexError({ code: "scale_set_identity_conflict" });
  verifyLabels(set.labels, row.labels);
  return client.generateJitConfig(row.scaleSetId, input.runnerName, signal);
}

export const cleanup = internalAction({
  args: { id: v.id("runnerScaleSets"), generation: v.number(), attempt: v.number() },
  handler: async (ctx, args): Promise<null> => {
    try {
      const authority = await ctx.runQuery(internal.runnerScaleSets.cleanupAuthority, {
        id: args.id,
        generation: args.generation,
      });
      if (!authority) return null;
      const { row } = authority;
      const signal = AbortSignal.timeout(90000);
      const access = await repositoryAccess(new GitHubAppClient(authority.app), {
        owner: row.repositoryOwner,
        repo: row.repositoryName,
        repositoryId: row.repositoryId,
        installationId: row.installationId,
        githubUserId: row.githubUserId,
        githubLogin: row.githubLogin,
        purpose: "cleanup",
      });
      const connection = await bootstrapAdmin(
        { owner: row.repositoryOwner, repo: row.repositoryName, installationToken: access.token },
        (url, init) => fetch(url, init),
        signal,
      );
      const admin = new ScaleSetAdminClient(
        connection.serviceUrl,
        connection.adminToken,
        (url, init) => fetch(url, init),
      );
      const group = await admin.defaultRunnerGroup(signal);
      const set = await admin.findScaleSet(group.id, row.name, signal);
      if (set) {
        if (row.scaleSetId !== undefined && row.scaleSetId !== set.id)
          throw new ConvexError({ code: "scale_set_identity_conflict" });
        const oldSessionId = row.sessionId;
        if (oldSessionId)
          await ignoreMissing(() => admin.deleteSession(set.id, oldSessionId, signal));
        await ignoreMissing(() => admin.deleteScaleSet(set.id, signal));
      }
      await ctx.runMutation(internal.runnerScaleSets.cleaned, {
        id: row._id,
        generation: row.generation,
      });
    } catch {
      if (args.attempt < 7)
        await ctx.scheduler.runAfter(
          Math.min(900000, 1000 * 5 ** args.attempt),
          internal.githubScaleSets.cleanup,
          { ...args, attempt: args.attempt + 1 },
        );
      else
        await ctx.runMutation(internal.runnerScaleSets.cleanupFailed, {
          id: args.id,
          generation: args.generation,
        });
    }
    return null;
  },
});
