import { CloudError } from "../errors.js";
import type { MachineContext, MachineHandler, Sweep } from "../context.js";
import type { Binding, GitHubAccount, ScaleSetRow } from "../db.js";
import type { Env } from "../env.js";
import { bindingAuthority } from "../authority.js";
import { loadApp } from "../github/app.js";
import { repositoryAccess } from "../github/access.js";
import {
  begin,
  checkpoint,
  failed,
  assertScaleSetBinding,
  currentScaleSet,
} from "./scale-sets-store.js";
import type { ScaleSetGrant } from "../../../../packages/protocol/src/scale-sets.js";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { runnerLabels } from "../../../../packages/github/src/runner-labels.js";
import {
  bootstrapAdmin,
  ScaleSetBootstrapHttpError,
  tokenExpiration,
} from "../../../../packages/scaleset/src/bootstrap.js";
import {
  ScaleSetAdminClient,
  ScaleSetHttpError,
} from "../../../../packages/scaleset/src/client.js";
import type { Session } from "../../../../packages/scaleset/src/messages.js";
type Authority = { binding: Binding; account: GitHubAccount };
type Access = { token: string };
// Admin credentials are short lived and stay inside this action invocation.
async function admin(authority: Authority, access: Access, signal: AbortSignal) {
  const connection = await bootstrapAdmin(
    {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      installationToken: access.token,
    },
    fetch,
    signal,
  );
  return new ScaleSetAdminClient(connection.serviceUrl, connection.adminToken, fetch);
}

async function connection(
  c: MachineContext,
  bindingId: string,
  preparing: boolean,
  signal: AbortSignal,
) {
  const authority = await bindingAuthority(c.env, c.machine, bindingId, preparing);
  if (preparing) assertScaleSetBinding(authority.binding);
  const app = await loadApp(c.env);
  const access = await repositoryAccess(new GitHubAppClient(app), {
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

function grant(row: ScaleSetRow, scaleSetId: number, session: Session): ScaleSetGrant {
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
  if (error instanceof CloudError) throw error;
  throw new CloudError("scale_set_unavailable", 502, {
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
    throw new CloudError("scale_set_labels_unsupported", 502, {
      message: "GitHub did not retain the scale set's custom runner labels.",
      nextStep: "Use demand capacity for this repository.",
    });
}

export const openScaleSet: MachineHandler<"/machine/scale-sets/open"> = async (c, args) => {
  const signal = AbortSignal.timeout(90000);
  const row = await begin(c, {
    ...args,
    operation: "open",
  });

  let created: { admin: ScaleSetAdminClient; scaleSetId: number; sessionId: string } | undefined;
  try {
    const { authority, admin } = await connection(c, args.bindingId, true, signal);
    const environment = authority.environment;
    if (!environment) throw new CloudError("environment_unavailable", 409);
    const group = await admin.defaultRunnerGroup(signal);
    const labels = [...runnerLabels(environment.os, environment.id), row.name];
    const found = await admin.findScaleSet(group.id, row.name, signal);
    if (found && row.scaleSetId !== null && found.id !== row.scaleSetId)
      throw new CloudError("scale_set_identity_conflict", 409);
    const set = found ?? (await admin.createScaleSet(group.id, row.name, labels, signal));
    await checkpoint(c, row, "opening", set.id);
    const effective = await admin.getScaleSet(set.id, signal);
    if (effective.name !== row.name || effective.runnerGroupId !== group.id)
      throw new CloudError("scale_set_identity_conflict", 409);
    verifyLabels(effective.labels, labels);
    const oldSessionId = row.sessionId;
    if (oldSessionId) await ignoreMissing(() => admin.deleteSession(set.id, oldSessionId, signal));
    const session = await admin
      .createSession(set.id, `${row.machineId}:${row.generation}`, signal)
      .catch((error: unknown) => {
        if (error instanceof ScaleSetHttpError && error.status === 409)
          throw new CloudError("scale_set_session_conflict", 502, {
            message: "GitHub already has a session whose identity Vectis cannot reconcile.",
            nextStep:
              "Close the other scale set listener or wait for its session to expire, then retry.",
          });
        throw error;
      });
    created = { admin, scaleSetId: set.id, sessionId: session.sessionId };
    await checkpoint(c, row, "active", set.id, session.sessionId);
    return grant(row, set.id, session);
  } catch (error) {
    if (created) {
      const session = created;
      await ignoreMissing(() =>
        session.admin.deleteSession(session.scaleSetId, session.sessionId),
      ).catch(() => undefined);
    }
    await failed(c, row);
    return scaleSetError(error);
  }
};

export const refreshScaleSet: MachineHandler<"/machine/scale-sets/refresh"> = async (c, args) => {
  const row = await begin(c, {
    ...args,
    operation: "refresh",
  });

  try {
    if (row.scaleSetId === null || !row.sessionId)
      throw new CloudError("scale_set_session_missing", 409);
    const signal = AbortSignal.timeout(90000);
    const { authority, admin } = await connection(c, args.bindingId, true, signal);
    const environment = authority.environment;
    if (!environment) throw new CloudError("environment_unavailable", 409);
    const set = await admin.getScaleSet(row.scaleSetId, signal);
    if (set.name !== row.name) throw new CloudError("scale_set_identity_conflict", 409);
    verifyLabels(set.labels, [...runnerLabels(environment.os, environment.id), row.name]);
    const session = await admin.refreshSession(row.scaleSetId, row.sessionId, signal);
    if (session.sessionId !== row.sessionId)
      throw new CloudError("scale_set_identity_conflict", 409);
    await checkpoint(c, row, "active", undefined, row.sessionId);
    return grant(row, row.scaleSetId, session);
  } catch (error) {
    await failed(c, row);
    return scaleSetError(error);
  }
};

export const closeScaleSet: MachineHandler<"/machine/scale-sets/close"> = async (c, args) => {
  const row = await begin(c, {
    ...args,
    operation: "close",
  });
  if (row.phase === "closed") return null;

  try {
    const { scaleSetId, sessionId } = row;
    if (scaleSetId !== null && sessionId) {
      const signal = AbortSignal.timeout(90000);
      const { admin } = await connection(c, args.bindingId, false, signal);
      await ignoreMissing(() => admin.deleteSession(scaleSetId, sessionId, signal));
    }
    await checkpoint(c, row, "closed");
    return null;
  } catch (error) {
    await failed(c, row);
    return scaleSetError(error);
  }
};

export async function generateScaleSetJit(
  c: MachineContext,
  input: { bindingId: string; generation: number; runnerName: string },
  authority: Authority,
  access: Access,
) {
  const { binding, environment } = await bindingAuthority(c.env, c.machine, input.bindingId, true);
  assertScaleSetBinding(binding);
  const row = await currentScaleSet(c.env, binding, input.generation);
  if (
    !["active", "refreshing"].includes(row.phase) ||
    !row.sessionId ||
    row.scaleSetId === null ||
    !environment
  )
    throw new CloudError("scale_set_session_missing", 409);
  const signal = AbortSignal.timeout(90000);
  const client = await admin(authority, access, signal);
  const set = await client.getScaleSet(row.scaleSetId, signal);
  if (set.name !== row.name) throw new CloudError("scale_set_identity_conflict", 409);
  verifyLabels(set.labels, [...runnerLabels(environment.os, environment.id), row.name]);
  return client.generateJitConfig(row.scaleSetId, input.runnerName, signal);
}
export async function markScaleSetsForCleanup(env: Env, bindingIds: string[]): Promise<void> {
  for (let offset = 0; offset < bindingIds.length; offset += 50) {
    const ids = bindingIds.slice(offset, offset + 50);
    await env.DB.prepare(
      `UPDATE runnerScaleSets SET phase = 'deleting', generation = generation + 1, cleanupDueAt = ?, cleanupAttempt = 0, updatedAt = ? WHERE bindingId IN (${ids.map(() => "?").join(",")}) AND phase != 'deleting'`,
    )
      .bind(Date.now(), Date.now(), ...ids)
      .run();
  }
}
export const sweepScaleSets: Sweep = async (env, now) => {
  // One row bounds cold GitHub token requests, including their retries.
  const rows = await env.DB.prepare(
    "SELECT * FROM runnerScaleSets WHERE phase = 'deleting' AND cleanupDueAt <= ? ORDER BY cleanupDueAt LIMIT 1",
  )
    .bind(now)
    .all<ScaleSetRow>();
  for (const row of rows.results) {
    try {
      const app = await loadApp(env);
      const signal = AbortSignal.timeout(90000);
      const access = await repositoryAccess(new GitHubAppClient(app), {
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
        fetch,
        signal,
      );
      const client = new ScaleSetAdminClient(connection.serviceUrl, connection.adminToken, fetch);
      const group = await client.defaultRunnerGroup(signal);
      const set = await client.findScaleSet(group.id, row.name, signal);
      if (set) {
        if (row.scaleSetId !== null && row.scaleSetId !== set.id)
          throw new CloudError("scale_set_identity_conflict", 409);
        const sessionId = row.sessionId;
        if (sessionId) await ignoreMissing(() => client.deleteSession(set.id, sessionId, signal));
        await ignoreMissing(() => client.deleteScaleSet(set.id, signal));
      }
      await env.DB.prepare(
        "DELETE FROM runnerScaleSets WHERE id = ? AND generation = ? AND phase = 'deleting'",
      )
        .bind(row.id, row.generation)
        .run();
    } catch {
      const terminal = row.cleanupAttempt >= 7;
      await env.DB.prepare(
        "UPDATE runnerScaleSets SET phase = ?, cleanupAttempt = ?, cleanupDueAt = ?, updatedAt = ? WHERE id = ? AND generation = ? AND phase = 'deleting' AND cleanupAttempt = ?",
      )
        .bind(
          terminal ? "action_required" : "deleting",
          row.cleanupAttempt + 1,
          terminal ? null : now + Math.min(900000, 1000 * 5 ** row.cleanupAttempt),
          now,
          row.id,
          row.generation,
          row.cleanupAttempt,
        )
        .run();
    }
  }
};
