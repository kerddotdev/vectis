import { Schema } from "effect";
import { createGitHubAppJwt, GitHubApiError } from "../../../../packages/github/src/app-client.js";
import type { Sweep } from "../context.js";
import { loadApp } from "./app.js";
import { CloudError } from "../errors.js";

const minute = 60_000;
const maxAge = 3 * 24 * 60 * minute;
const events = new Set(["workflow_job", "installation", "installation_repositories", "repository"]);
const deliveries = Schema.Array(
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^\d{1,30}$/)),
    guid: Schema.NonEmptyString,
    delivered_at: Schema.String,
    status_code: Schema.NullOr(Schema.Int),
    event: Schema.String,
  }),
);

function nextCursor(link: string | null) {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    const url = match?.[1];
    if (url) {
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) throw new Error("GitHub delivery pagination is missing its cursor.");
      return cursor;
    }
  }
  return null;
}

export const sweepRedelivery: Sweep = async (env, now) => {
  let app;
  try {
    app = await loadApp(env);
  } catch (error) {
    if (error instanceof CloudError && error.code === "github_app_unavailable") return;
    throw error;
  }
  const checkpoint = await env.DB.prepare(
    "SELECT deliveredAt FROM githubRedeliveryCheckpoint WHERE singleton = 1",
  ).first<{ deliveredAt: number }>();
  const state = { app, checkpoint };
  const since = Math.max(state.checkpoint?.deliveredAt ?? now - 60 * minute, now - maxAge);
  const through = now - minute;
  const deadline = now + 90_000;
  const signal = AbortSignal.timeout(90_000);
  const headers = {
    Authorization: `Bearer ${createGitHubAppJwt(state.app)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  let fetches = 0;
  const request = async (path: string, method: "GET" | "POST") => {
    if (++fetches > 40) throw new Error("GitHub delivery request budget exhausted.");
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubApiError(response.status);
    }
    return response;
  };

  const attempts = new Map<string, { id: string; deliveredAt: number; successful: boolean }>();
  let complete = false;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ per_page: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await request(`/app/hook/deliveries?${params}`, "GET");
      // Delivery IDs exceed Number.MAX_SAFE_INTEGER, so they must stay strings.
      const text = (await response.text()).replace(/"id":\s*(\d+)/g, '"id":"$1"');
      const rows = Schema.decodeUnknownSync(deliveries)(JSON.parse(text));
      if (rows.length > 100) throw new Error("GitHub exceeded the delivery page limit.");
      for (const row of rows) {
        const deliveredAt = Date.parse(row.delivered_at);
        if (!Number.isFinite(deliveredAt)) throw new Error("Invalid GitHub delivery timestamp.");
        if (deliveredAt < since) {
          complete = true;
          break;
        }
        if (!events.has(row.event)) continue;
        const successful =
          row.status_code !== null && row.status_code >= 200 && row.status_code < 300;
        const existing = attempts.get(row.guid);
        if (!existing || deliveredAt > existing.deliveredAt)
          attempts.set(row.guid, {
            id: row.id,
            deliveredAt,
            successful: successful || existing?.successful === true,
          });
        else existing.successful ||= successful;
      }
      cursor = nextCursor(response.headers.get("link"));
      if (complete || !cursor || rows.length === 0) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    console.warn("GitHub webhook delivery listing failed; checkpoint unchanged.", String(error));
    return;
  }
  if (!complete) {
    console.warn("GitHub webhook delivery page limit reached; checkpoint unchanged.");
    return;
  }

  const candidates = [...attempts.entries()]
    .filter(([, attempt]) => !attempt.successful && attempt.deliveredAt <= through)
    .sort((a, b) => a[1].deliveredAt - b[1].deliveredAt);
  let requested = 0;
  for (const [guid, attempt] of candidates) {
    if (requested >= 20 || fetches >= 40 || Date.now() >= deadline || signal.aborted) {
      complete = false;
      break;
    }
    const claim = await env.DB.prepare(
      "INSERT INTO githubRedeliveryRequests (guid, requestedAt) VALUES (?, ?) ON CONFLICT DO NOTHING",
    )
      .bind(guid, now)
      .run();
    if (!claim.meta.changes) continue;
    requested++;
    try {
      const response = await request(`/app/hook/deliveries/${attempt.id}/attempts`, "POST");
      await response.body?.cancel();
    } catch (error) {
      console.warn("GitHub webhook redelivery request failed; it will not be repeated.", {
        guid,
        deliveryId: attempt.id,
        error,
      });
      complete = false;
      break;
    }
  }
  if (!complete) {
    console.warn("GitHub webhook redelivery scan incomplete; checkpoint unchanged.");
    return;
  }
  // Fresh attempts remain in the next scan, even when this run saw newer successful deliveries.
  await env.DB.prepare(`INSERT INTO githubRedeliveryCheckpoint (singleton, deliveredAt, scannedAt) VALUES (1, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET deliveredAt = excluded.deliveredAt, scannedAt = excluded.scannedAt
      WHERE githubRedeliveryCheckpoint.deliveredAt < excluded.deliveredAt`)
    .bind(through, now)
    .run();
};
