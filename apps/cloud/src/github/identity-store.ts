import { Schema } from "effect";
import { GitHubUser } from "../../../../packages/protocol/src/cloud.js";
import type { Env } from "../env.js";
import type { GitHubLinkRow, GitHubAccountRow } from "../db.js";
import { CloudError } from "../errors.js";
import { newId } from "../ids.js";
import { loadApp } from "./app.js";
import { markScaleSetsForCleanup } from "../runners/scale-sets.js";
import { notifyMachine } from "../notify.js";
export async function createLink(
  env: Env,
  input: { owner: string; digest: string; verifier: string; browserDigest: string },
) {
  const app = await loadApp(env),
    now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO githubLinks (id, owner, digest, verifier, browserDigest, expiresAt, phase) SELECT ?, ?, ?, ?, ?, ?, 'pending' WHERE (SELECT COUNT(*) FROM githubLinks WHERE owner = ? AND expiresAt > ?) < 5`,
  )
    .bind(
      newId(),
      input.owner,
      input.digest,
      input.verifier,
      input.browserDigest,
      now + 600000,
      input.owner,
      now,
    )
    .run();
  if (!result.meta.changes) throw new CloudError("github_link_rate_limit");
  return { clientId: app.clientId };
}
export async function claimLink(env: Env, input: { digest: string; browserDigest: string }) {
  const app = await loadApp(env);
  const link = await env.DB.prepare("SELECT * FROM githubLinks WHERE digest = ?")
    .bind(input.digest)
    .first<GitHubLinkRow>();
  if (!link?.verifier || link.browserDigest !== input.browserDigest) return null;
  const result = await env.DB.prepare(
    "UPDATE githubLinks SET phase = 'exchanging', verifier = NULL WHERE id = ? AND phase = 'pending' AND expiresAt > ? AND browserDigest = ?",
  )
    .bind(link.id, Date.now(), input.browserDigest)
    .run();
  return result.meta.changes
    ? {
        id: link.id,
        verifier: link.verifier,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        appId: app.appId,
      }
    : null;
}
export async function finishLink(
  env: Env,
  input: { id: string; user?: typeof GitHubUser.Type; completionDigest?: string },
) {
  await env.DB.prepare(
    "UPDATE githubLinks SET phase = ?, userJson = ?, completionDigest = ? WHERE id = ? AND phase = 'exchanging' AND expiresAt > ?",
  )
    .bind(
      input.user ? "review" : "failed",
      input.user ? JSON.stringify(input.user) : null,
      input.completionDigest ?? null,
      input.id,
      Date.now(),
    )
    .run();
}
export async function confirmLink(
  env: Env,
  input: { owner: string; id: string; browserDigest: string; completionDigest: string },
) {
  const link = await env.DB.prepare(
    "SELECT * FROM githubLinks WHERE id = ? AND owner = ? AND phase = 'review' AND browserDigest = ? AND completionDigest = ? AND expiresAt > ?",
  )
    .bind(input.id, input.owner, input.browserDigest, input.completionDigest, Date.now())
    .first<GitHubLinkRow>();
  if (!link?.userJson) throw new CloudError("github_link_unavailable");
  const user = Schema.decodeUnknownSync(GitHubUser)(JSON.parse(link.userJson));
  const existing = await env.DB.prepare("SELECT * FROM githubAccounts WHERE githubId = ?")
    .bind(user.id)
    .first<GitHubAccountRow>();
  if (existing && existing.owner !== input.owner)
    throw new CloudError("github_account_already_linked");
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO githubAccounts (id, owner, githubId, login, installationsJson, verifiedAt) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM githubLinks WHERE id = ? AND phase = 'review' AND expiresAt > ?) ON CONFLICT(githubId) DO UPDATE SET login = excluded.login, installationsJson = excluded.installationsJson, verifiedAt = excluded.verifiedAt WHERE githubAccounts.owner = excluded.owner`,
    ).bind(
      existing?.id ?? newId(),
      input.owner,
      user.id,
      user.login,
      JSON.stringify(user.installations),
      Date.now(),
      link.id,
      Date.now(),
    ),
    env.DB.prepare(
      "DELETE FROM githubLinks WHERE id = ? AND EXISTS (SELECT 1 FROM githubAccounts WHERE githubId = ? AND owner = ?)",
    ).bind(link.id, user.id, input.owner),
  ]);
  const saved = await env.DB.prepare("SELECT owner, id FROM githubAccounts WHERE githubId = ?")
    .bind(user.id)
    .first<{ owner: string; id: string }>();
  if (saved?.owner !== input.owner) throw new CloudError("github_account_already_linked");
  if (!results[0]?.meta.changes) throw new CloudError("github_link_unavailable");
  const machines = await env.DB.prepare(
    "SELECT DISTINCT machineId FROM repositoryBindings WHERE accountId = ?",
  )
    .bind(saved.id)
    .all<{ machineId: string }>();
  await Promise.all(machines.results.map((m) => notifyMachine(env, m.machineId)));
}
export async function unlink(env: Env, owner: string, id: string) {
  const account = await env.DB.prepare("SELECT owner FROM githubAccounts WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (account?.owner !== owner) throw new CloudError("github_account_unavailable");
  const bindings = await env.DB.prepare(
    "SELECT id, machineId FROM repositoryBindings WHERE accountId = ?",
  )
    .bind(id)
    .all<{ id: string; machineId: string }>();
  await markScaleSetsForCleanup(
    env,
    bindings.results.map((b) => b.id),
  );
  await env.DB.prepare("DELETE FROM githubAccounts WHERE id = ? AND owner = ?")
    .bind(id, owner)
    .run();
  await Promise.all(
    [...new Set(bindings.results.map((b) => b.machineId))].map((id) => notifyMachine(env, id)),
  );
}
export async function discard(env: Env, owner: string, id: string) {
  const result = await env.DB.prepare("DELETE FROM githubLinks WHERE id = ? AND owner = ?")
    .bind(id, owner)
    .run();
  if (!result.meta.changes) throw new CloudError("github_link_unavailable");
}
export async function accountsForMachine(env: Env, owner: string) {
  return (
    await env.DB.prepare("SELECT id, githubId, login FROM githubAccounts WHERE owner = ? LIMIT 100")
      .bind(owner)
      .all<{ id: string; githubId: number; login: string }>()
  ).results;
}
