import { Schema } from "effect";
import { readCacheWrite } from "../../../../packages/github/src/cache-write.js";
import { runnerLabels } from "../../../../packages/github/src/runner-labels.js";
import { GitHubApiError, GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { CloudError } from "../errors.js";
import { bindingAuthority } from "../authority.js";
import { loadApp } from "../github/app.js";
import { githubErrors, repositoryAccess } from "../github/access.js";
import { newId } from "../ids.js";
import { notifyMachine } from "../notify.js";
import {
  bindingRecord,
  accountRecord,
  type BindingRow,
  type GitHubAccountRow,
  type GitHubAppRow,
  type LeaseRow,
} from "../db.js";
import type { MachineHandler, Sweep } from "../context.js";
import { admission, claim, owned, ready, attention, released } from "./leases-store.js";
import { generateScaleSetJit } from "./scale-sets-github.js";
const Runner = Schema.Struct({ id: Schema.Int, name: Schema.String });
const RunnerState = Schema.Struct({
  ...Runner.fields,
  busy: Schema.Boolean,
  status: Schema.Literals(["online", "offline"]),
});
const Registration = Schema.Struct({ runner: Runner, encoded_jit_config: Schema.NonEmptyString });
const Pool = Schema.Struct({ total_count: Schema.Int, runners: Schema.Array(Runner) });

export const prepareRunner: MachineHandler<"/machine/runners/prepare"> = async (c, args) => {
  if (!args.key.trim() || args.key.length > 200)
    throw new CloudError("invalid_runner_request", 409);
  const authority = await authorize(c, {
    bindingId: args.bindingId,
    preparing: true,
    ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
    ...(args.automatic === undefined ? {} : { automatic: args.automatic }),
    ...(args.scaleSet ? { scaleSet: args.scaleSet } : {}),
  });
  const client = new GitHubAppClient(authority.app);
  const access = await repositoryAccess(client, {
    owner: authority.binding.repositoryOwner ?? authority.account.login,
    repo: authority.binding.repositoryName,
    repositoryId: authority.binding.repositoryId,
    githubUserId: authority.account.githubId,
    githubLogin: authority.account.login,
  });
  if (access.installationId !== authority.binding.installationId)
    throw new CloudError("installation_changed", 409, {
      nextStep: "Reconnect this repository to its current GitHub App installation.",
    });
  const { fresh, lease } = await claim(c, args);
  if (!fresh) {
    if (
      lease.phase === "ready" &&
      lease.encodedConfig &&
      lease.runnerId &&
      (lease.configExpiresAt ?? 0) > Date.now()
    )
      return {
        state: "ready",
        id: lease.id,
        runnerId: lease.runnerId,
        encodedConfig: lease.encodedConfig,
        cacheWrite: lease.cacheWrite ?? false,
        ...(lease.cacheWriteReason ? { cacheWriteReason: lease.cacheWriteReason } : {}),
        environmentId: lease.environmentId,
        os: lease.os,
        ...(lease.access
          ? {
              access: {
                ...lease.access,
                ...(lease.cacheRun ? { cacheRun: lease.cacheRun } : {}),
              },
            }
          : {}),
      };
    if (lease.phase === "released") return { state: "released", id: lease.id };
    if (lease.phase === "preparing" && Date.now() - lease.updatedAt < 60000)
      return { state: "pending", id: lease.id };
    await attention(c, lease.id);
    return { state: "action_required", id: lease.id };
  }
  const cacheJob = authority.cacheJob;
  const cache =
    !args.scaleSet && cacheJob
      ? await (async () => {
          try {
            const jobs = await repositoryAccess(client, {
              owner: authority.binding.repositoryOwner ?? authority.account.login,
              repo: authority.binding.repositoryName,
              repositoryId: authority.binding.repositoryId,
              githubUserId: authority.account.githubId,
              githubLogin: authority.account.login,
              purpose: "jobs",
            });
            if (jobs.installationId !== access.installationId)
              return { cacheWrite: false, cacheWriteReason: "installation_changed" };
            return await readCacheWrite(
              (path) => client.request(jobs.token, jobs.path + path),
              authority.binding.repositoryId,
              cacheJob.runId,
              cacheJob.runAttempt,
            );
          } catch {
            return { cacheWrite: false, cacheWriteReason: "metadata_unavailable" };
          }
        })()
      : {
          cacheWrite: false,
          cacheWriteReason: args.scaleSet
            ? "scale_set_run_unknown"
            : authority.binding.cacheVolume?.enabled
              ? "job_unknown"
              : "cache_disabled",
        };
  let runnerId: number | undefined;
  try {
    const scaleSetRegistration = args.scaleSet
      ? await generateScaleSetJit(
          c,
          {
            bindingId: args.bindingId,
            generation: args.scaleSet.generation,
            runnerName: `vectis-${lease.id}`,
          },
          authority,
          access,
        )
      : undefined;
    const registration = scaleSetRegistration
      ? {
          runner: scaleSetRegistration.runner,
          encoded_jit_config: scaleSetRegistration.encodedJITConfig,
        }
      : Schema.decodeUnknownSync(Registration)(
          await client.request(access.token, `${access.path}/actions/runners/generate-jitconfig`, {
            name: `vectis-${lease.id}`,
            runner_group_id: 1,
            labels: runnerLabels(lease.os, lease.environmentId),
            work_folder: "_work",
          }),
        );
    runnerId = registration.runner.id;
    if (registration.runner.name !== `vectis-${lease.id}`)
      throw new Error("Runner identity mismatch.");
    if (args.scaleSet) {
      const registered = Schema.decodeUnknownSync(Runner)(
        await client.request(access.token, `${access.path}/actions/runners/${runnerId}`),
      );
      if (registered.id !== runnerId || registered.name !== `vectis-${lease.id}`)
        throw new Error("Runner identity mismatch.");
    }
    await ready(c, {
      id: lease.id,
      runnerId,
      encodedConfig: registration.encoded_jit_config,
      ...cache,
    });
    return {
      state: "ready",
      id: lease.id,
      runnerId,
      encodedConfig: registration.encoded_jit_config,
      cacheWrite: cache.cacheWrite,
      ...(cache.cacheWriteReason ? { cacheWriteReason: cache.cacheWriteReason } : {}),
      environmentId: lease.environmentId,
      os: lease.os,
      ...(lease.access
        ? { access: { ...lease.access, ...(cache.cacheRun ? { cacheRun: cache.cacheRun } : {}) } }
        : {}),
    };
  } catch {
    await attention(c, lease.id, runnerId);
    return { state: "action_required", id: lease.id };
  }
};

export const releaseRunner: MachineHandler<"/machine/runners/release"> = async (c, args) =>
  githubErrors(async () => {
    const lease = await owned(c, args.id);
    if (lease.phase === "released") return { state: "released", id: lease.id };
    if (lease.phase === "preparing" && Date.now() - lease.updatedAt < 60000)
      throw new CloudError("runner_lease_pending", 409, {
        nextStep: "Wait for registration to finish before reconciling this lease.",
      });
    const authority = await authorize(c, {
      bindingId: lease.bindingId,
      preparing: false,
    });
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
      purpose: "cleanup",
    });
    const expectedName = `vectis-${lease.id}`;
    let runnerId = lease.runnerId;
    if (runnerId === undefined) {
      let searched = false;
      for (let page = 1; page <= 10; page++) {
        const pool = Schema.decodeUnknownSync(Pool)(
          await client.request(
            access.token,
            `${access.path}/actions/runners?per_page=100&page=${page}`,
          ),
        );
        const matches = pool.runners.filter((runner) => runner.name === expectedName);
        if (matches.length > 1) throw new CloudError("runner_identity_conflict", 409);
        if (matches[0]) {
          runnerId = matches[0].id;
          searched = true;
          break;
        }
        if (page * 100 >= pool.total_count) {
          searched = true;
          break;
        }
      }
      if (!searched)
        throw new CloudError("runner_reconciliation_limit", 409, {
          nextStep: "Inspect the repository runner pool before retrying cleanup.",
        });
    }
    if (runnerId !== undefined) {
      const path = `${access.path}/actions/runners/${runnerId}`;
      try {
        const runner = Schema.decodeUnknownSync(Runner)(await client.request(access.token, path));
        if (runner.id !== runnerId || runner.name !== expectedName)
          throw new CloudError("runner_identity_conflict", 409);
        try {
          await client.delete(access.token, path);
        } catch (error) {
          if (error instanceof GitHubApiError && error.status === 422)
            throw new CloudError("runner_busy", 409, {
              message: "GitHub still shows this runner on a job.",
              nextStep:
                "Vectis retries cleanup automatically after GitHub releases the job, usually within 15 minutes.",
            });
          throw error;
        }
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      }
    }
    await released(c, lease.id);
    return { state: "released", id: lease.id };
  });

export const runnerStatus: MachineHandler<"/machine/runners/status"> = async (c, args) =>
  githubErrors(async () => {
    const { lease, authority } = await statusAuthority(c, args.id);
    if (lease.phase === "released") return { missing: true };
    if (lease.runnerId === undefined) throw new CloudError("runner_registration_incomplete", 409);
    const client = new GitHubAppClient(authority.app);
    const access = await repositoryAccess(client, {
      owner: authority.binding.repositoryOwner ?? authority.account.login,
      repo: authority.binding.repositoryName,
      repositoryId: authority.binding.repositoryId,
      githubUserId: authority.account.githubId,
      githubLogin: authority.account.login,
      purpose: "cleanup",
    });
    try {
      const runner = Schema.decodeUnknownSync(RunnerState)(
        await client.request(access.token, `${access.path}/actions/runners/${lease.runnerId}`),
      );
      if (runner.id !== lease.runnerId || runner.name !== `vectis-${lease.id}`)
        throw new CloudError("runner_identity_conflict", 409);
      return { busy: runner.busy, status: runner.status };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return { missing: true };
      throw error;
    }
  });

async function authorize(
  c: Parameters<typeof admission>[0],
  args: {
    bindingId: string;
    preparing: boolean;
    jobId?: number;
    automatic?: boolean;
    scaleSet?: { generation: number };
  },
) {
  const authority = args.preparing
    ? await admission(c, args)
    : { ...(await bindingAuthority(c.env, c.machine, args.bindingId, false)), cacheJob: null };
  return { ...authority, app: await loadApp(c.env) };
}
export const reconcileRunner: MachineHandler<"/machine/runners/reconcile"> = async (c, args) => {
  const { binding, environment } = await bindingAuthority(c.env, c.machine, args.bindingId, false);
  if (!args.key.trim() || args.key.length > 200 || binding.environmentId !== args.environmentId)
    throw new CloudError("invalid_runner_request", 400);
  let row = await c.env.DB.prepare("SELECT * FROM runnerLeases WHERE machineId = ? AND key = ?")
    .bind(c.machine.id, args.key)
    .first<LeaseRow>();
  if (!row) {
    if (!environment) throw new CloudError("environment_unavailable", 409);
    const now = Date.now();
    const result = await c.env.DB.prepare(
      "INSERT INTO runnerLeases (id,owner,machineId,bindingId,environmentId,os,environmentRevision,key,phase,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,'released',?,?) ON CONFLICT (machineId,key) DO NOTHING",
    )
      .bind(
        newId(),
        c.machine.owner,
        c.machine.id,
        binding.id,
        environment.id,
        environment.os,
        environment.revision ?? null,
        args.key,
        now,
        now,
      )
      .run();
    row = await c.env.DB.prepare("SELECT * FROM runnerLeases WHERE machineId = ? AND key = ?")
      .bind(c.machine.id, args.key)
      .first<LeaseRow>();
    if (result.meta.changes) await notifyMachine(c.env, c.machine.id);
  }
  if (
    !row ||
    row.owner !== c.machine.owner ||
    row.bindingId !== binding.id ||
    row.environmentId !== args.environmentId
  )
    throw new CloudError("runner_identity_mismatch", 409);
  return {
    id: row.id,
    bindingId: row.bindingId,
    environmentId: row.environmentId,
    phase: row.phase,
  };
};
export const sweepLeases: Sweep = async (env, now) => {
  await env.DB.prepare(
    "UPDATE runnerLeases SET encodedConfig = NULL, configExpiresAt = NULL WHERE id IN (SELECT id FROM runnerLeases WHERE configExpiresAt IS NOT NULL AND configExpiresAt <= ? ORDER BY configExpiresAt LIMIT 100)",
  )
    .bind(now)
    .run();
};

async function statusAuthority(c: Parameters<typeof admission>[0], id: string) {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id, bindingId, phase, runnerId FROM runnerLeases WHERE id = ? AND machineId = ? AND owner = ?",
    ).bind(id, c.machine.id, c.machine.owner),
    c.env.DB.prepare(
      "SELECT b.* FROM repositoryBindings b JOIN runnerLeases l ON l.bindingId = b.id WHERE l.id = ? AND l.machineId = ? AND l.owner = ?",
    ).bind(id, c.machine.id, c.machine.owner),
    c.env.DB.prepare(
      "SELECT a.* FROM githubAccounts a JOIN repositoryBindings b ON b.accountId = a.id JOIN runnerLeases l ON l.bindingId = b.id WHERE l.id = ? AND l.machineId = ? AND l.owner = ?",
    ).bind(id, c.machine.id, c.machine.owner),
    c.env.DB.prepare("SELECT * FROM githubApps WHERE singleton = 1"),
  ]);
  const lease = results[0]?.results[0] as
    | Pick<LeaseRow, "id" | "bindingId" | "phase" | "runnerId">
    | undefined;
  const binding = results[1]?.results[0] as BindingRow | undefined;
  const account = results[2]?.results[0] as GitHubAccountRow | undefined;
  const app = results[3]?.results[0] as GitHubAppRow | undefined;
  if (!lease) throw new CloudError("runner_lease_missing", 404);
  if (
    !binding ||
    binding.machineId !== c.machine.id ||
    binding.owner !== c.machine.owner ||
    !account ||
    account.owner !== c.machine.owner
  )
    throw new CloudError("repository_access_denied", 403);
  if (!app) throw new CloudError("github_app_unavailable", 503);
  return {
    lease: { ...lease, runnerId: lease.runnerId ?? undefined },
    authority: { binding: bindingRecord(binding), account: accountRecord(account), app },
  };
}
