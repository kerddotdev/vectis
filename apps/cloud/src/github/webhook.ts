import { Schema } from "effect";
import type { RawHandler } from "../context.js";
import { CloudError } from "../errors.js";
import { readBody } from "../http.js";
import { loadApp } from "./app.js";
import { GitHubJob } from "../../../../packages/github/src/job.js";
import { verifyWebhook } from "../../../../packages/github/src/webhook.js";
import { GitHubAppClient } from "../../../../packages/github/src/app-client.js";
import { readRunActors, withRunActors } from "../../../../packages/github/src/run-actors.js";
import { storeJob, jobChanged } from "./job-store.js";
import { restrictiveAuthority, accessFor } from "./jobs-private.js";
import type { Env } from "../env.js";
import type { GitHubAppRow } from "../db.js";

const Payload = Schema.Struct({
  action: Schema.optional(Schema.String),
  installation: Schema.optional(Schema.Struct({ id: Schema.Int })),
  repository: Schema.optional(Schema.Struct({ id: Schema.Int })),
  workflow_job: Schema.optional(GitHubJob),
});

async function enrich(
  env: Env,
  app: GitHubAppRow,
  authority: NonNullable<Awaited<ReturnType<typeof restrictiveAuthority>>>,
  job: GitHubJob,
) {
  const client = new GitHubAppClient(app);
  const access = await accessFor(client, authority);
  const actors = await readRunActors(
    (path) => client.request(access.token, access.path + path),
    access.repositoryId,
    job.run_id,
  );
  const result = await storeJob(
    env,
    withRunActors(job, actors),
    access.installationId,
    access.repositoryId,
  );
  if (result.changed) await jobChanged(env, result.row);
}

export const githubWebhook: RawHandler = async (c, request) => {
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (
    !event ||
    !["ping", "workflow_job", "installation", "installation_repositories", "repository"].includes(
      event,
    ) ||
    !deliveryId ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId)
  )
    return new Response("Invalid delivery", { status: 400 });
  let body;
  try {
    body = await readBody(request, 1024 * 1024);
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  let app;
  try {
    app = await loadApp(c.env);
  } catch (error) {
    if (error instanceof CloudError && error.code === "github_app_unavailable")
      return new Response("App setup is incomplete", { status: 503 });
    throw error;
  }
  if (!(await verifyWebhook(app.webhookSecret, body, request.headers.get("x-hub-signature-256"))))
    return new Response("Invalid signature", { status: 401 });
  if (event === "ping") return Response.json({ accepted: true });
  let payload;
  try {
    payload = Schema.decodeUnknownSync(Payload)(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  const job = payload.workflow_job ? { ...payload.workflow_job } : undefined;
  if (job) {
    delete job.actor_id;
    delete job.triggering_actor_id;
  }
  const installationId = payload.installation?.id ?? null;
  const repositoryId = payload.repository?.id ?? null;
  const delivery = {
    deliveryId,
    event,
    action: payload.action ?? null,
    installationId,
    repositoryId,
    jobId: job?.id ?? null,
    receivedAt: Date.now(),
  };
  let duplicate;
  if (job && event === "workflow_job" && installationId && repositoryId) {
    const result = await storeJob(c.env, job, installationId, repositoryId, delivery);
    duplicate = result.duplicate;
    if (result.changed) await jobChanged(c.env, result.row);
    if (!duplicate) {
      const authority = await restrictiveAuthority(c.env, installationId, repositoryId);
      if (authority) c.ctx.waitUntil(enrich(c.env, app, authority, job));
    }
  } else {
    const result =
      await c.env.DB.prepare(`INSERT INTO githubDeliveries (deliveryId,event,action,installationId,repositoryId,jobId,receivedAt)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(
          deliveryId,
          event,
          delivery.action,
          installationId,
          repositoryId,
          delivery.jobId,
          delivery.receivedAt,
        )
        .run();
    duplicate = !result.meta.changes;
  }
  return Response.json({ accepted: true, duplicate }, { status: 202 });
};
